/**
 * Cairn - Agent-Bridge compaction (ADR-0006 mode 3).
 *
 * Shells out to the OTHER already-logged-in CLI (`claude -p` / `codex exec`), which runs the
 * completion on that CLI's OAuth SUBSCRIPTION session - no API key. This is "login über das
 * andere Abo": Cairn never authenticates; it borrows the CLI's existing session.
 *
 * Hardening: those CLIs run the FULL agent, which otherwise editorializes (preamble, repo/env
 * commentary). We force a pure compaction by (a) passing the 7-bucket + BRIEF_ONLY directive as
 * the system prompt (claude `--system-prompt` + `--exclude-dynamic-system-prompt-sections`;
 * codex via the stdin prompt since it has no system flag), (b) running in a NEUTRAL cwd so there
 * is no repo context to comment on, and (c) a `stripPreamble` safety net. The process spawn is an
 * injectable seam so the logic is unit-testable without a real CLI.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ModelCaller, ModelCallRequest, ModelCallResult } from "./providers.js";
import { t, type Lang } from "../i18n/index.js";

export type BridgeCli = "claude" | "codex";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ExecFn = (
  cmd: string,
  args: string[],
  /** `env`: variables set on top of the inherited environment for this child only. */
  opts: { stdin?: string; timeoutMs: number; cwd?: string; env?: Record<string, string> },
) => Promise<ExecResult>;

export interface BridgeInput {
  cli: BridgeCli;
  request: ModelCallRequest;
  /** Reasoning depth: claude `--effort <level>`, codex `-c model_reasoning_effort=<level>`. */
  effort?: string;
  execFn?: ExecFn;
  timeoutMs?: number;
  /** Language for the brief-only directive. Default 'en'. */
  lang?: Lang;
}

/** Default spawn-based exec: feeds the prompt on stdin, captures stdout/stderr, enforces a timeout. */
export const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise<ExecResult>((resolve, reject) => {
    const env = opts.env ? { ...process.env, ...opts.env } : process.env;
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd: opts.cwd, env });
    let stdout = "";
    let stderr = "";
    let stdinError: string | undefined;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // A CLI that did not take the whole prompt answered something else: never a success, even with exit 0.
      if (stdinError) {
        resolve({ stdout, stderr: `${stderr}\n[cairn] prompt not fully written to ${cmd}: ${stdinError}`, code: code || 1 });
        return;
      }
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    if (opts.stdin != null) {
      // A CLI that exits before reading all of stdin (e.g. a startup failure) fails the write with EPIPE once the
      // prompt exceeds the pipe buffer. Unhandled, that error would crash the whole process and a calibration
      // run would lose its artifact; it is recorded instead and makes the call fail (see "close").
      child.stdin.on("error", (e: NodeJS.ErrnoException) => {
        stdinError = e.code ?? e.message;
      });
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });

/** Forces the bridged CLI agent into a pure compaction service (no preamble/meta/tools). */
function systemFor(request: ModelCallRequest, lang: Lang): string {
  const briefOnly = t(lang).prompts.briefOnly;
  return request.systemPrompt ? `${request.systemPrompt}\n\n${briefOnly}` : briefOnly;
}

/** Only pass a model name that looks like a real id (must start alphanumeric) - never let an
 *  untrusted value like "-flag" be parsed as a CLI option. */
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** Effort tier must be a bare lowercase word (low|medium|high|xhigh|max) - no arg/config injection. */
const SAFE_EFFORT = /^[a-z]+$/;
/** Set for every claude child, in its environment and via `--settings` (ADR-0012): no CLAUDE.md or auto
 *  memory in a compaction/review, no claude.ai connectors (fetched for a logged-in subscription). */
const CLAUDE_ISOLATION_ENV = { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false" } as const;

/** Codex context `--ignore-user-config` still loads (ADR-0012): the skills catalog (all skill roots, e.g.
 *  $CODEX_HOME/skills, ~/.agents/skills, bundled), a project AGENTS.md in the shared tmpdir cwd, the
 *  ChatGPT apps connector, and the multi-agent tools (`spawn_agent` …, which would start further model
 *  calls). `-c` overrides outrank the user layer (Codex's managed_config.toml and requirements still win).
 *  Codex 0.162 has no switch for $CODEX_HOME/AGENTS.override.md or AGENTS.md, a `$<skill>` mention in the
 *  input still injects that skill, and its own exec/shell tools stay (read-only sandbox). */
const CODEX_ISOLATION_OVERRIDES = [
  "skills.include_instructions=false",
  "project_doc_max_bytes=0",
  "features.apps=false",
  "agents.enabled=false",
] as const;

/** Where Claude Code reads a managed-mcp.json (managed-mcp docs, "Exclusive control"). */
export function managedMcpConfigPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-mcp.json";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-mcp.json";
  return "/etc/claude-code/managed-mcp.json";
}

/** Is a managed-mcp.json deployed? Claude Code then loads only the managed set. When the file is valid
 *  (Claude Code's own parse and schema), `--strict-mcp-config` makes it exit at startup; when it is not,
 *  Claude Code 2.1.296 still keeps that exclusive control. So existence decides, not our parse (Claude Code
 *  also accepts a UTF-8 BOM).
 *  OS edges are injectable for testing. */
export function managedMcpConfigPresent(
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return exists(managedMcpConfigPath(platform));
}

/** The levels Claude Code documents for `--effort` / CLAUDE_CODE_EFFORT_LEVEL; only these are pinned. */
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * The models that produced output in a claude run, from `modelUsage` (`{ "<model>": { outputTokens,
 * thinkingTokens, … } }`). A fallback - a configured `fallbackModel` chain, or the automatic switch after a
 * refusal - can answer instead of the requested model, which then shows up with no output, with partial
 * output (refusal mid-stream) or not at all. An entry without token counts counts as having answered.
 * `undefined` when the CLI reports no usage.
 */
export function answeringModels(modelUsage: unknown): string[] | undefined {
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  const out: string[] = [];
  for (const [model, u] of Object.entries(modelUsage as Record<string, unknown>)) {
    const usage = (u ?? {}) as Record<string, unknown>;
    const counts = [usage.outputTokens, usage.thinkingTokens].filter((n): n is number => typeof n === "number");
    if (counts.length === 0 || counts.some((n) => n > 0)) out.push(model);
  }
  return out;
}

/**
 * Did a `codex exec --json` run fail? `turn.failed` always means so. A `{"type":"error"}` event alone does
 * not: codex also emits it for a stream error it retries (`will_retry`, the turn goes on), so it counts
 * only when no `turn.completed` follows. Otherwise the error message would come back as the answer text.
 */
export function codexRunFailed(stdout: string): boolean {
  let failed = false;
  let pendingError = false;
  for (const line of stdout.split("\n")) {
    let type: unknown;
    try {
      type = (JSON.parse(line.trim()) as { type?: unknown })?.type;
    } catch {
      continue;
    }
    if (type === "turn.failed") failed = true;
    else if (type === "error") pendingError = true;
    else if (type === "turn.completed") pendingError = false;
  }
  return failed || pendingError;
}

/**
 * The failure reason of a `codex exec --json` run, which codex writes to stdout only: the latest non-empty
 * message of a `turn.failed` event or of an `error` event that no `turn.completed` follows (an error
 * codex retried is no reason). Empty when there is none.
 */
export function codexErrorMessage(stdout: string): string {
  let failed = { at: -1, message: "" }; // latest turn.failed
  let pending = { at: -1, message: "" }; // latest error not (yet) followed by turn.completed
  stdout.split("\n").forEach((line, at) => {
    let ev: { type?: unknown; message?: unknown; error?: { message?: unknown } };
    try {
      ev = JSON.parse(line.trim());
    } catch {
      return;
    }
    if (ev?.type === "error" && typeof ev.message === "string" && ev.message) pending = { at, message: ev.message };
    else if (ev?.type === "turn.failed" && typeof ev.error?.message === "string" && ev.error.message) failed = { at, message: ev.error.message };
    else if (ev?.type === "turn.completed") pending = { at: -1, message: "" };
  });
  return (pending.at > failed.at ? pending : failed).message;
}

/** A Codex safeguard reroute: `codex exec --json` reports it as an error item
 *  `"model rerouted: <from> -> <to> (<reason>)"` (openai/codex exec JSONL processor). */
export function codexReroute(stdout: string): { from: string; to: string } | undefined {
  let found: { from: string; to: string } | undefined;
  for (const line of stdout.split("\n")) {
    let ev: { type?: unknown; item?: { type?: unknown; message?: unknown } };
    try {
      ev = JSON.parse(line.trim());
    } catch {
      continue;
    }
    const msg = ev?.type === "item.completed" && ev.item?.type === "error" ? ev.item.message : undefined;
    const m = typeof msg === "string" ? msg.match(/^model rerouted: (\S+) -> (\S+)/) : null;
    if (m) found = { from: m[1], to: m[2] };
  }
  return found;
}

/** Safety net: if the CLI still editorialized, trim everything before the first bucket. */
export function stripPreamble(text: string): string {
  const m = text.match(/(?:^|\n)\s*(1\)\s*DECISIONS|DECISIONS\b)/i);
  if (m && m.index != null) {
    const idx = text.indexOf(m[1], m.index);
    if (idx >= 0) return text.slice(idx).trim();
  }
  return text.trim();
}

/**
 * Extract the final assistant text from `codex exec --json` JSONL events. The real shape is
 * `{type:"item.completed", item:{type:"agent_message", text}}`; a lenient fallback also accepts
 * plain `text`/`message` fields for robustness across codex versions.
 */
export function parseCodexJsonl(stdout: string): string {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  let agentText = "";
  let lastText = "";
  for (const line of lines) {
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object") continue;
    const o = ev as Record<string, unknown>;
    const item = o.item as Record<string, unknown> | undefined;
    if (o.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
      agentText = item.text;
    } else if (o.type === "error" || o.type === "turn.failed") {
      continue; // an error message is never the answer (codex also reports retried stream errors this way)
    } else if (typeof o.text === "string") {
      lastText = o.text;
    } else if (typeof o.message === "string") {
      lastText = o.message;
    } else if (o.message && typeof (o.message as Record<string, unknown>).content === "string") {
      lastText = (o.message as Record<string, unknown>).content as string;
    }
  }
  return agentText || lastText;
}

export interface RunBridgeInput {
  cli: BridgeCli;
  /** System prompt (claude: `--system-prompt`; codex: prepended to stdin). */
  system: string;
  /** User content on stdin. */
  user: string;
  model?: string;
  effort?: string;
  execFn?: ExecFn;
  timeoutMs?: number;
  /** Seam for tests; defaults to `managedMcpConfigPresent()`. */
  managedMcp?: () => boolean;
}

/**
 * Generic hardened CLI call on the subscription session (used by both compaction and review).
 * Same security posture everywhere: claude with ALL tools disabled (built-in and MCP) + no permission
 * bypass, no CLAUDE.md, connectors or transcript; codex read-only sandbox, ignore-user-config, ephemeral,
 * no skills catalog, project AGENTS.md or apps; neutral cwd. Returns the RAW model text.
 */
export async function runBridge(input: RunBridgeInput): Promise<ModelCallResult> {
  const exec = input.execFn ?? defaultExec;
  const timeoutMs = input.timeoutMs ?? 120_000;
  const cwd = tmpdir(); // neutral cwd → no repo/env context for the agent to editorialize on
  const { cli, system, user, model, effort } = input;

  if (cli === "claude") {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--system-prompt",
      system,
      "--exclude-dynamic-system-prompt-sections",
      // Security (audit finding 1): structurally disable ALL tools so prompt-injected text cannot
      // drive tool/command execution; never inherit a stored bypassPermissions.
      "--tools",
      "",
      "--permission-mode",
      "default",
      // Context isolation (ADR-0012): `--tools ""` covers built-in tools only, so user-scope and plugin MCP
      // servers would start and offer their tools. The deny rule removes every MCP tool (not a server's
      // instructions); `--strict-mcp-config` below keeps the servers from loading at all.
      "--disallowedTools",
      "mcp__*",
      // A compaction or review is no session to resume: no transcript under ~/.claude/projects.
      "--no-session-persistence",
    ];
    // Without `--mcp-config` strict mode loads no MCP server. Under a valid managed-mcp.json Claude Code exits
    // at startup on that flag; there only the managed servers load, and the deny rule removes their tools.
    if (!(input.managedMcp ?? managedMcpConfigPresent)()) args.push("--strict-mcp-config");
    if (model && SAFE_MODEL.test(model)) args.push("--model", model);
    if (effort && SAFE_EFFORT.test(effort)) args.push("--effort", effort);
    // Effort pin (ADR-0012): CLAUDE_CODE_EFFORT_LEVEL outranks `--effort`, and a settings `env` block outranks
    // the shell, so an inherited or configured `medium` would silently win. Pin a documented level in the
    // child's environment AND via `--settings` (outranks user settings; managed settings still win).
    const pinned = effort && CLAUDE_EFFORTS.has(effort) ? effort : undefined;
    // No user/plugin hooks in a pure compaction/review call: a prompt or agent hook runs its own model,
    // which `modelUsage` would then report as a second answering model (managed hooks, Agent SDK hooks,
    // hooks of managed-forced plugins and built-in mods still run).
    const env: Record<string, string> = { ...CLAUDE_ISOLATION_ENV, ...(pinned ? { CLAUDE_CODE_EFFORT_LEVEL: pinned } : {}) };
    const settings = { disableAllHooks: true, disableClaudeAiConnectors: true, env };
    args.push("--settings", JSON.stringify(settings));
    // The neutral cwd is the shared tmpdir: never load project/local settings (hooks, env, effort caps) from it.
    args.push("--setting-sources", "user");
    const { stdout, stderr, code } = await exec("claude", args, { stdin: user, timeoutMs, cwd, env });
    if (code !== 0 && !stdout.trim()) throw new Error(`claude bridge failed (code ${code}): ${stderr.slice(0, 300)}`);
    try {
      // With `verbose` on (a user setting), `--output-format json` prints an array of events; the last
      // `result` event carries what the object form holds.
      const parsed = JSON.parse(stdout) as unknown;
      const json = (
        Array.isArray(parsed) ? [...parsed].reverse().find((e) => e?.type === "result") ?? {} : parsed
      ) as Record<string, unknown>;
      const text = typeof json.result === "string" ? json.result : "";
      // `is_error` wins over `subtype`: an API error or a refusal mid-stream comes back as `subtype: "success"`
      // with the error message as `result`.
      const finishReason =
        json.is_error === true || code !== 0 ? "error" : typeof json.subtype === "string" ? json.subtype : "stop";
      const modelsUsed = answeringModels(json.modelUsage);
      const modelsReported =
        json.modelUsage && typeof json.modelUsage === "object" ? Object.keys(json.modelUsage as Record<string, unknown>) : undefined;
      return { text, truncated: false, finishReason, ...(modelsReported ? { modelsUsed, modelsReported } : {}) };
    } catch {
      return { text: stdout.trim(), truncated: false, finishReason: code !== 0 ? "error" : "stop" };
    }
  }

  // codex: no system-prompt flag → fold it into the stdin prompt; neutral cwd via -C; read-only
  // sandbox + skip the trusted-git gate; ignore-user-config + ephemeral (audit finding 2). `--ignore-rules`:
  // the user's execpolicy allow rules would let a matching command run outside the sandbox (ADR-0012).
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "-C",
    cwd,
  ];
  if (model && SAFE_MODEL.test(model)) args.push("--model", model);
  if (effort && SAFE_EFFORT.test(effort)) args.push("-c", `model_reasoning_effort=${effort}`);
  for (const override of CODEX_ISOLATION_OVERRIDES) args.push("-c", override);
  const { stdout, stderr, code } = await exec("codex", args, { stdin: `${system}\n\n${user}`, timeoutMs, cwd });
  const text = parseCodexJsonl(stdout);
  const failed = code !== 0 || codexRunFailed(stdout);
  if (!text && failed) {
    throw new Error(`codex bridge failed (code ${code}): ${(codexErrorMessage(stdout) || stderr).slice(0, 300)}`);
  }
  // Codex names no model in its events except a safeguard reroute; report it so calibration can see it.
  const reroute = codexReroute(stdout);
  return {
    text,
    truncated: false,
    finishReason: failed ? "error" : "stop",
    ...(reroute ? { modelsUsed: [reroute.to], modelsReported: [reroute.from, reroute.to] } : {}),
  };
}

/** Effort of the product's bridge mode (ADR-0012): every bridged compaction runs at `high`, never the CLI
 *  default (Claude Code runs Opus, Sonnet and Haiku 5.5 at `medium`). */
export const PRODUCT_BRIDGE_EFFORT = "high";

/** The bridge-mode caller the MCP server wires up for `CAIRN_BRIDGE`, always at PRODUCT_BRIDGE_EFFORT. */
export function productBridge(cli: BridgeCli, lang: Lang, execFn?: ExecFn): ModelCaller {
  return (req) => bridgeCompact({ cli, request: req, lang, effort: PRODUCT_BRIDGE_EFFORT, execFn });
}

/** Run a COMPACTION on the given CLI's subscription session (7-bucket + brief-only directive). */
export async function bridgeCompact(input: BridgeInput): Promise<ModelCallResult> {
  const r = await runBridge({
    cli: input.cli,
    system: systemFor(input.request, input.lang ?? "en"),
    user: input.request.prompt,
    model: input.request.model,
    effort: input.effort,
    execFn: input.execFn,
    timeoutMs: input.timeoutMs,
  });
  return { ...r, text: stripPreamble(r.text) };
}
