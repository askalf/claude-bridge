/**
 * Discord-native Claude agent.
 * Full agent loop running over Discord — no Claude Code CLI needed.
 * Uses dario proxy for OAuth/billing, executes tools locally.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const DARIO_URL = process.env.DARIO_URL || 'http://localhost:3456';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_TURNS = 30;
const MAX_OUTPUT = 1500; // Discord message limit safety

// ── Tool definitions matching Claude Code ──

const TOOLS = [
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

// ── Tool execution ──

function executeTool(name: string, input: Record<string, unknown>): string {
  try {
    switch (name) {
      case 'Bash': {
        const cmd = input.command as string;
        // Security: block dangerous commands
        const blocked = ['rm -rf /', 'mkfs', 'dd if=', ':(){', 'fork bomb'];
        if (blocked.some(b => cmd.includes(b))) return 'Blocked: dangerous command';
        const timeout = (input.timeout as number) || 30_000;
        const output = execSync(cmd, {
          encoding: 'utf-8',
          timeout,
          maxBuffer: 1024 * 1024,
          cwd: process.env.AGENT_CWD || homedir(),
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
        const dir = (input.path as string) || process.env.AGENT_CWD || '.';
        const pattern = input.pattern as string;
        // Simple glob via find/ls
        try {
          const output = execSync(
            `find "${dir}" -name "${pattern}" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -50`,
            { encoding: 'utf-8', timeout: 10_000 }
          );
          return output || 'No matches';
        } catch { return 'No matches'; }
      }

      case 'Grep': {
        const dir = (input.path as string) || process.env.AGENT_CWD || '.';
        const pattern = input.pattern as string;
        try {
          const output = execSync(
            `grep -rn "${pattern}" "${dir}" --include="*.ts" --include="*.js" --include="*.json" --include="*.md" --include="*.py" 2>/dev/null | head -30`,
            { encoding: 'utf-8', timeout: 10_000 }
          );
          return output || 'No matches';
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

export class DiscordAgent {
  private messages: Array<Record<string, unknown>> = [];
  private model: string;
  private systemPrompt: string;
  private busy = false;

  constructor(opts?: { model?: string; cwd?: string }) {
    this.model = opts?.model || DEFAULT_MODEL;
    const cwd = opts?.cwd || process.env.AGENT_CWD || homedir();
    this.systemPrompt = `You are the askalf engineering assistant, running on Thomas's machine via Discord. You have full tool access to the local filesystem and shell.

Working directory: ${cwd}

You work for Thomas (askalf). Use tools to discover projects, check git repos, read files — don't guess. If you don't know something, look it up with Bash, Read, Glob, or Grep.

Key context:
- dario v3.0.0 uses template replay (cc-template.ts) — replaces entire request with CC template
- mux is at integration.tax, landing page live, waitlist active
- All Cloudflare: askalf.org (landing), app.askalf.org (dashboard), integration.tax (mux)
- Auth system live on CF Workers + D1
- 17 fleet agents running in Docker (forge)
- Claude bridge (this) provides Discord remote access

Keep responses concise — Discord has a 2000 char limit. Use code blocks for output. Don't add emojis unless asked.`;
  }

  get isBusy(): boolean { return this.busy; }

  /** Process a user message and return the final text response. */
  async process(
    userMessage: string,
    onToolUse?: (name: string, args: string) => void,
    onText?: (text: string) => void,
  ): Promise<string> {
    if (this.busy) return '_Already processing a request. Wait for it to finish._';
    this.busy = true;

    try {
      this.messages.push({ role: 'user', content: userMessage });

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const response = await this.callApi();

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

            if (onToolUse) onToolUse(name, JSON.stringify(args).slice(0, 100));

            const output = executeTool(name, args);
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

  /** Call the Anthropic API through dario proxy. */
  private async callApi(): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${DARIO_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'dario',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 8192,
          system: this.systemPrompt,
          messages: this.messages,
          tools: TOOLS,
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
