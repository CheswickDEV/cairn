/**
 * Cairn - the host session's transcript, for the opt-in automatic compaction in account mode (ADR-0012).
 *
 * Claude Code: `~/.claude/projects/<project dir, every non-alphanumeric character as "-">/<session id>.jsonl`.
 * Claude Code hands both values to its MCP servers (`CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_SESSION_ID`). The
 * file is a tree (`parentUuid`): a rewound conversation leaves its abandoned branch in the file, so only
 * the path from the newest message back to the root is read, and only from the last compact boundary on.
 * Side chains (subagents), injected meta messages, thinking and harness reminders are left out.
 *
 * Codex: the session's rollout (`codex-rollout.ts` lookup). Only user and assistant messages, tool calls
 * and their output are read, from the last compaction on; developer messages (base instructions,
 * AGENTS.md, environment context) are left out.
 *
 * Both renderings are plain text for one compaction prompt. Nothing here calls a model.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexSessionsDir, findActiveRollout } from "../surface/codex-rollout.js";

export type TranscriptCli = "claude" | "codex";

/** Claude Code's project directory name: every character that is not a letter or digit becomes "-". */
export function claudeProjectSlug(projectDir: string): string {
  return projectDir.replace(/[^A-Za-z0-9]/g, "-");
}

/** The current Claude Code session's transcript file, or undefined without the two environment values. */
export function locateClaudeTranscript(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | undefined {
  const dir = env.CLAUDE_PROJECT_DIR;
  const session = env.CLAUDE_CODE_SESSION_ID;
  if (!dir || !session || !/^[A-Za-z0-9-]+$/.test(session)) return undefined;
  const base = env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const path = join(base, "projects", claudeProjectSlug(dir), `${session}.jsonl`);
  try {
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

/** The current Codex session's rollout (pin `CAIRN_CODEX_SESSION`, else the newest one for this cwd). */
export function locateCodexRollout(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string | undefined {
  return findActiveRollout(codexSessionsDir(env), { cwd, sessionMatch: env.CAIRN_CODEX_SESSION }) ?? undefined;
}

interface ClaudeEntry {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { role?: string; content?: unknown };
}

const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: { type?: string; text?: string }) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

function parseLines<T>(jsonl: string): T[] {
  const out: T[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // a torn last line while the host is still writing: skip it
    }
  }
  return out;
}

/** The active branch of a Claude Code transcript, rendered as text (see the module comment). */
export function renderClaudeTranscript(jsonl: string): string {
  const entries = parseLines<ClaudeEntry>(jsonl).filter((e) => typeof e.uuid === "string");
  const byId = new Map(entries.map((e) => [e.uuid!, e]));
  const leaf = [...entries].reverse().find((e) => (e.type === "user" || e.type === "assistant") && !e.isSidechain);
  if (!leaf) return "";
  const path: ClaudeEntry[] = [];
  const seen = new Set<string>();
  for (let e: ClaudeEntry | undefined = leaf; e && !seen.has(e.uuid!); e = e.parentUuid ? byId.get(e.parentUuid) : undefined) {
    seen.add(e.uuid!);
    path.push(e);
  }
  path.reverse();
  const boundary = path.map((e) => e.type === "system" && e.subtype === "compact_boundary").lastIndexOf(true);
  const out: string[] = [];
  for (const e of path.slice(boundary + 1)) {
    if (e.isSidechain || !e.message) continue;
    const content = e.message.content;
    if (e.type === "user") {
      if (e.isMeta) continue;
      const label = e.isCompactSummary ? "EARLIER CONTEXT (compacted)" : "USER";
      if (typeof content === "string") {
        const text = content.replace(REMINDER_RE, "").trim();
        if (text) out.push(`${label}: ${text}`);
        continue;
      }
      for (const b of Array.isArray(content) ? content : []) {
        if (b?.type === "text" && typeof b.text === "string") {
          const text = b.text.replace(REMINDER_RE, "").trim();
          if (text) out.push(`${label}: ${text}`);
        } else if (b?.type === "tool_result") {
          const text = blockText(b.content).replace(REMINDER_RE, "").trim();
          out.push(`TOOL RESULT${b.is_error ? " (error)" : ""}: ${text}`);
        }
      }
    } else if (e.type === "assistant") {
      for (const b of Array.isArray(content) ? content : []) {
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) out.push(`ASSISTANT: ${b.text.trim()}`);
        else if (b?.type === "tool_use") out.push(`TOOL CALL ${b.name}: ${JSON.stringify(b.input)}`);
      }
    }
  }
  return out.join("\n\n");
}

interface RolloutEntry {
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    name?: string;
    arguments?: string;
    input?: string;
    output?: unknown;
    message?: string;
  };
}

/** Codex wraps its own context (AGENTS.md, environment) as user messages with these leading tags. */
const CODEX_CONTEXT_RE = /^\s*(<environment_context>|<user_instructions>|# AGENTS\.md instructions)/;

/** A Codex rollout's conversation, rendered as text (see the module comment). */
export function renderCodexRollout(jsonl: string): string {
  const entries = parseLines<RolloutEntry>(jsonl);
  const lastCompact = entries.map((e) => e.type === "compacted").lastIndexOf(true);
  const out: string[] = [];
  if (lastCompact >= 0 && typeof entries[lastCompact].payload?.message === "string") {
    out.push(`EARLIER CONTEXT (compacted): ${entries[lastCompact].payload!.message!.trim()}`);
  }
  for (const e of entries.slice(lastCompact + 1)) {
    if (e.type !== "response_item" || !e.payload) continue;
    const p = e.payload;
    if (p.type === "message") {
      if (p.role !== "user" && p.role !== "assistant") continue;
      const text = (p.content ?? []).map((c) => (typeof c.text === "string" ? c.text : "")).join("\n").trim();
      if (!text || (p.role === "user" && CODEX_CONTEXT_RE.test(text))) continue;
      out.push(`${p.role === "user" ? "USER" : "ASSISTANT"}: ${text}`);
    } else if (p.type?.endsWith("_call")) {
      out.push(`TOOL CALL ${p.name ?? p.type}: ${p.arguments ?? p.input ?? ""}`.trim());
    } else if (p.type?.endsWith("_call_output")) {
      const o = p.output;
      const text = typeof o === "string" ? o : JSON.stringify(o);
      out.push(`TOOL RESULT: ${text}`);
    }
  }
  return out.join("\n\n");
}

/** The current session's rendered transcript for `cli`, or undefined if it cannot be found. */
export function readSessionTranscript(cli: TranscriptCli, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = cli === "claude" ? locateClaudeTranscript(env) : locateCodexRollout(env);
  if (!path) return undefined;
  const raw = readFileSync(path, "utf8");
  const text = cli === "claude" ? renderClaudeTranscript(raw) : renderCodexRollout(raw);
  return text.trim() ? text : undefined;
}
