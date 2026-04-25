/**
 * Discord-native Claude agent.
 * Full agent loop running over Discord — no Claude Code CLI needed.
 * Uses a dario-compatible proxy (or any Anthropic-compat endpoint) for
 * OAuth / billing, executes tools locally on the host machine.
 */

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_BASE_URL = 'http://localhost:3456';
const DEFAULT_API_KEY = 'dario';
const MAX_TURNS = 30;

// Default system prompt: intentionally generic. Callers who want to
// specialize the agent for a project / persona / tool style pass their
// own via `systemPrompt` in the constructor options (which the CLI
// surfaces as the `system_prompt` config field). Don't hardcode
// user-specific context here — this file ships in the public package.
const DEFAULT_SYSTEM_PROMPT = [
  'You are a coding and operations assistant running on the user\'s local machine via a Discord bridge. You have full tool access to the host filesystem and shell (Bash, Read, Write, Glob, Grep).',
  '',
  'Use tools to ground your answers — don\'t guess at file contents, project layout, or git state when you can look them up. Keep responses under the Discord 2000-char limit; use code blocks for command output; skip emojis unless the user uses them first.',
].join('\n');

// ── Tool definitions matching Claude Code ──

/** Shape of an entry in `TOOLS`. Used by `callApi` and by `filterTools`. */
type ToolDef = { name: string; description: string; input_schema: unknown };

const TOOLS: ToolDef[] = [
  {
    name: 'Bash',
    description: 'Execute a bash command and return its output.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: { type: 'number', description: 'Timeout in ms (default 30000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    description: 'Read a file from the filesystem.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to file' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file (creates or overwrites).',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to file' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Glob',
    description: 'Find files matching a glob pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern' },
        path: { type: 'string', description: 'Directory to search in' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description: 'Search file contents with regex.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern' },
        path: { type: 'string', description: 'Directory or file to search' },
      },
      required: ['pattern'],
    },
  },
];

/**
 * Read-only tool subset used when sandbox/safe mode is on and the
 * caller hasn't confirmed the request (i.e. no `!confirm` prefix on
 * the inbound Discord reply). These three tools can inspect the
 * filesystem but cannot mutate it or shell out.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep']);

/**
 * Strip a `!confirm ` prefix from an inbound message and report whether
 * it was present. Pure helper — exported so the reply-parser contract
 * is unit-testable without spinning up the full agent.
 *
 * Examples:
 *   `'!confirm fix the bug'` → `{ confirmed: true,  prompt: 'fix the bug' }`
 *   `'fix the bug'`          → `{ confirmed: false, prompt: 'fix the bug' }`
 *   `'!confirm'`             → `{ confirmed: true,  prompt: '' }`   // no prompt
 *
 * Match is anchored to the start of the trimmed message; `!confirm`
 * appearing later in the body is intentionally NOT a confirmation
 * (otherwise asking "should I add a !confirm step here?" would
 * accidentally elevate the call).
 */
export function parseConfirmPrefix(message: string): { confirmed: boolean; prompt: string } {
  const trimmed = message.trim();
  const m = trimmed.match(/^!confirm(?:\s+(.*))?$/s);
  if (m) return { confirmed: true, prompt: (m[1] ?? '').trim() };
  return { confirmed: false, prompt: trimmed };
}

/**
 * Whether an `executeTool()` return string represents a tool failure.
 * The catch-block contract (see executeTool) is to return `Error: <msg>`
 * for thrown errors; success returns are tool-specific output that may
 * legitimately start with anything else. Exported for unit testing.
 */
export function isErrorOutput(s: string): boolean {
  return s.startsWith('Error: ');
}

/**
 * Filter a tool list by an allowedTools set. `undefined` allowed-set
 * means no restriction (returns the original list). Pure helper —
 * exported so the safe-mode filter contract is unit-testable.
 */
export function filterTools<T extends { name: string }>(
  tools: readonly T[],
  allowed: ReadonlySet<string> | undefined,
): T[] {
  if (!allowed) return [...tools];
  return tools.filter(t => allowed.has(t.name));
}

// ── Tool execution ──

// SECURITY: every tool here runs on the host with the running user's
// full shell access. The security model is the allowlist in discord-bot:
// a user not in `allowed_user_ids` can't emit a tool call at all. We
// intentionally don't try to filter dangerous commands at this layer —
// a blocklist on shell input is trivially bypassed (whitespace tricks,
// path obfuscation, shell indirection) and the false-sense-of-security
// it gives is worse than explicit "yes, this is a high-trust tool."
//
// If you can't tolerate shell-level access to your machine from a chat
// client, don't run claude-bridge.
function executeTool(name: string, input: Record<string, unknown>, cwd: string): string {
  try {
    switch (name) {
      case 'Bash': {
        const cmd = input.command as string;
        const timeout = (input.timeout as number) || 30_000;
        const output = execSync(cmd, {
          encoding: 'utf-8',
          timeout,
          maxBuffer: 1024 * 1024,
          cwd,
        });
        return output.slice(0, 10_000);
      }

      case 'Read': {
        const path = resolve(input.file_path as string);
        return readFileSync(path, 'utf-8').slice(0, 10_000);
      }

      case 'Write': {
        const path = resolve(input.file_path as string);
        writeFileSync(path, input.content as string);
        return `Written to ${path}`;
      }

      case 'Glob': {
        // execFileSync with argv array — args are passed to find(1) as
        // distinct argv[] entries, not spliced into a shell string, so
        // metacharacters in `pattern` or `dir` can't escape into shell.
        const dir = (input.path as string) || cwd;
        const pattern = input.pattern as string;
        try {
          const output = execFileSync(
            'find',
            [
              dir,
              '-name', pattern,
              '-not', '-path', '*/node_modules/*',
              '-not', '-path', '*/.git/*',
            ],
            { encoding: 'utf-8', timeout: 10_000, maxBuffer: 1024 * 1024 },
          );
          const lines = output.split('\n').filter(Boolean).slice(0, 50);
          return lines.length > 0 ? lines.join('\n') : 'No matches';
        } catch { return 'No matches'; }
      }

      case 'Grep': {
        const dir = (input.path as string) || cwd;
        const pattern = input.pattern as string;
        try {
          const output = execFileSync(
            'grep',
            [
              '-rn',
              '--include=*.ts',
              '--include=*.js',
              '--include=*.json',
              '--include=*.md',
              '--include=*.py',
              pattern,
              dir,
            ],
            { encoding: 'utf-8', timeout: 10_000, maxBuffer: 1024 * 1024 },
          );
          const lines = output.split('\n').filter(Boolean).slice(0, 30);
          return lines.length > 0 ? lines.join('\n') : 'No matches';
        } catch { return 'No matches'; }
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 2000);
  }
}

// ── Agent loop ──

export interface DiscordAgentOptions {
  /** Model ID to send to the proxy. Default: claude-sonnet-4-6. */
  model?: string;
  /** Working directory for Bash / Glob / Grep. Default: $AGENT_CWD or homedir. */
  cwd?: string;
  /** Anthropic-compat base URL. Default: http://localhost:3456 (dario). */
  baseUrl?: string;
  /** API key sent as x-api-key. Default: "dario" (matches dario's default). */
  apiKey?: string;
  /** Override the default system prompt with your own. */
  systemPrompt?: string;
}

/**
 * Per-call options for `DiscordAgent.process()`. All fields optional;
 * the empty bag is the unobservable, full-tool default that matches
 * pre-feature behavior.
 */
export interface ProcessOptions {
  /**
   * Fired BEFORE each tool invocation. `args` is JSON-stringified and
   * truncated to 100 chars (Discord-line-friendly preview).
   */
  onToolUse?: (name: string, args: string) => void;

  /**
   * Fired AFTER each tool invocation completes (success OR error). The
   * audit-streaming counterpart to onToolUse — gives the caller enough
   * to render a `← Bash ✓ 1.2s` style line in Discord with a tail of
   * the output. `error` is set iff the tool returned a string starting
   * with `'Error: '`; in that case `result === error`.
   */
  onToolResult?: (
    name: string,
    args: string,
    result: string,
    durationMs: number,
    error?: string,
  ) => void;

  /**
   * Restrict the agent to a subset of `TOOLS` for THIS call. `undefined`
   * (the default) means no restriction. Used by safe-mode to clamp
   * unconfirmed phone-origin replies to read-only tools (Read / Glob /
   * Grep). The restriction is applied at the API request — the model
   * never sees the filtered-out tools, so it can't try to call them.
   */
  allowedTools?: ReadonlySet<string>;
}

export class DiscordAgent {
  private messages: Array<Record<string, unknown>> = [];
  private model: string;
  private cwd: string;
  private baseUrl: string;
  private apiKey: string;
  private systemPrompt: string;
  private busy = false;

  constructor(opts: DiscordAgentOptions = {}) {
    this.model = opts.model || DEFAULT_MODEL;
    this.cwd = opts.cwd || process.env.AGENT_CWD || homedir();
    this.baseUrl = opts.baseUrl || process.env.DARIO_URL || DEFAULT_BASE_URL;
    this.apiKey = opts.apiKey || process.env.DARIO_API_KEY || DEFAULT_API_KEY;

    const customPrompt = opts.systemPrompt ?? process.env.AGENT_SYSTEM_PROMPT;
    const base = customPrompt && customPrompt.trim().length > 0
      ? customPrompt
      : DEFAULT_SYSTEM_PROMPT;
    this.systemPrompt = `${base}\n\nWorking directory: ${this.cwd}`;
  }

  get isBusy(): boolean { return this.busy; }

  /** Process a user message and return the final text response. */
  async process(userMessage: string, opts: ProcessOptions = {}): Promise<string> {
    if (this.busy) return '_Already processing a request. Wait for it to finish._';
    this.busy = true;

    const { onToolUse, onToolResult, allowedTools } = opts;
    const callTools = filterTools(TOOLS, allowedTools);

    try {
      this.messages.push({ role: 'user', content: userMessage });

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const response = await this.callApi(callTools);

        if (!response) {
          this.busy = false;
          return '_API error — check if dario is running._';
        }

        const content = response.content as Array<Record<string, unknown>>;
        this.messages.push({ role: 'assistant', content });

        // Check if done (no tool calls)
        if (response.stop_reason !== 'tool_use') {
          const text = content
            .filter((b: Record<string, unknown>) => b.type === 'text')
            .map((b: Record<string, unknown>) => b.text as string)
            .join('\n');
          this.busy = false;
          return text || '_No response._';
        }

        // Execute tool calls
        const toolResults: Array<Record<string, unknown>> = [];
        for (const block of content) {
          if (block.type === 'tool_use') {
            const name = block.name as string;
            const args = block.input as Record<string, unknown>;
            const toolId = block.id as string;
            const argsStr = JSON.stringify(args);

            if (onToolUse) onToolUse(name, argsStr.slice(0, 100));

            const t0 = Date.now();
            const output = executeTool(name, args, this.cwd);
            const durationMs = Date.now() - t0;
            const error = isErrorOutput(output) ? output : undefined;

            if (onToolResult) onToolResult(name, argsStr, output, durationMs, error);

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolId,
              content: output,
            });
          }
        }

        this.messages.push({ role: 'user', content: toolResults });
      }

      this.busy = false;
      return '_Reached max turns._';
    } catch (e) {
      this.busy = false;
      return `_Error: ${e instanceof Error ? e.message : String(e)}_`;
    }
  }

  /** Call the Anthropic-compat API (dario by default). */
  private async callApi(callTools: readonly ToolDef[]): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 8192,
          system: this.systemPrompt,
          messages: this.messages,
          tools: callTools,
        }),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => '');
        console.error(`[agent] API error ${res.status}: ${err.slice(0, 200)}`);
        return null;
      }

      return await res.json() as Record<string, unknown>;
    } catch (e) {
      console.error(`[agent] Fetch error: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** Reset conversation history. */
  reset(): void {
    this.messages = [];
  }
}
