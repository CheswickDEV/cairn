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
import type { ModelCallRequest, ModelCallResult } from "./providers.js";
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
  opts: { stdin?: string; timeoutMs: number; cwd?: string },
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
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd: opts.cwd });
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
    const { stdout, stderr, code } = await exec("claude", args, { stdin: user, timeoutMs, cwd });
    if (code !== 0 && !stdout.trim()) throw new Error(`claude bridge failed (code ${code}): ${stderr.slice(0, 300)}`);
    try {
      const json = JSON.parse(stdout) as Record<string, unknown>;
      const text = typeof json.result === "string" ? json.result : "";
      const finishReason = typeof json.subtype === "string" ? json.subtype : json.is_error ? "error" : "stop";
      return { text, truncated: false, finishReason };
    } catch {
      return { text: stdout.trim(), truncated: false, finishReason: "stop" };
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
  if (!text && code !== 0) throw new Error(`codex bridge failed (code ${code}): ${stderr.slice(0, 300)}`);
  return { text, truncated: false, finishReason: "stop" };
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
