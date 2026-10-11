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
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    if (opts.stdin != null) {
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

/** The last error message a `codex exec --json` run reported (`error` / `turn.failed` events) - the
 *  failure reason, which codex writes to stdout only. A retried error that a `turn.completed` followed
 *  is no reason. */
export function codexErrorMessage(stdout: string): string {
  let message = "";
  for (const line of stdout.split("\n")) {
    let ev: { type?: unknown; message?: unknown; error?: { message?: unknown } };
    try {
      ev = JSON.parse(line.trim());
    } catch {
      continue;
    }
    if (ev?.type === "error" && typeof ev.message === "string") message = ev.message;
    else if (ev?.type === "turn.failed" && typeof ev.error?.message === "string") message = ev.error.message;
    else if (ev?.type === "turn.completed") message = "";
  }
  return message;
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
}

/**
 * Generic hardened CLI call on the subscription session (used by both compaction and review).
 * Same security posture everywhere: claude with ALL tools disabled + no permission bypass; codex
 * read-only sandbox, ignore-user-config, ephemeral; neutral cwd. Returns the RAW model text.
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
    ];
    if (model && SAFE_MODEL.test(model)) args.push("--model", model);
    if (effort && SAFE_EFFORT.test(effort)) args.push("--effort", effort);
    // Effort pin (ADR-0012): CLAUDE_CODE_EFFORT_LEVEL outranks `--effort`, and a settings `env` block outranks
    // the shell, so an inherited or configured `medium` would silently win. Pin a documented level in the
    // child's environment AND via `--settings` (outranks user settings; managed settings still win).
    const pinned = effort && CLAUDE_EFFORTS.has(effort) ? effort : undefined;
    // No user/plugin hooks in a pure compaction/review call: a prompt or agent hook runs its own model,
    // which `modelUsage` would then report as a second answering model (managed hooks still run).
    const settings = { disableAllHooks: true, ...(pinned ? { env: { CLAUDE_CODE_EFFORT_LEVEL: pinned } } : {}) };
    args.push("--settings", JSON.stringify(settings));
    // The neutral cwd is the shared tmpdir: never load project/local settings (hooks, env, effort caps) from it.
    args.push("--setting-sources", "user");
    const env = pinned ? { CLAUDE_CODE_EFFORT_LEVEL: pinned } : undefined;
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
  // sandbox + skip the trusted-git gate; ignore-user-config + ephemeral (audit finding 2).
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--ignore-user-config",
    "--ephemeral",
    "-C",
    cwd,
  ];
  if (model && SAFE_MODEL.test(model)) args.push("--model", model);
  if (effort && SAFE_EFFORT.test(effort)) args.push("-c", `model_reasoning_effort=${effort}`);
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
