/**
 * Cairn - ambient zone reader for OpenAI Codex (ADR-0008).
 *
 * Codex writes one `token_count` event per turn into its session rollout file
 * (`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`), carrying both the context usage
 * (`info.last_token_usage.total_tokens`) and the active window (`info.model_context_window`).
 * This module reads that file out-of-band (read-only, no DOM-scraping, no new dependency) and
 * reuses the existing zone logic via `renderStatusline()` - so the zone is computed against the
 * ACTIVE window from the rollout, not the model max (ADR-0003).
 *
 * Pure (`parseRolloutUsage`/`renderCodexStatusLine`) and IO (`findActiveRollout`/
 * `readCodexStatusLine`) are kept separate so the parse + render are unit-testable.
 *
 * The rollout layout is Codex-internal/unversioned → parsing is defensive (keyed off field
 * presence, not fragile `type` strings) and treated as `provisional`; a format change breaks only
 * this ambient reader, never the MCP core (ADR-0008).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { renderStatusline } from "./statusline.js";
import { t, messages, type Lang } from "../i18n/index.js";

/** Fallback line (English default) shown when no active Codex rollout is available. The IO helpers
 *  below resolve the localized variant from their `lang` argument; this const stays English so
 *  existing importers/tests keep a stable reference. */
export const NO_CONTEXT_LINE = messages.en.codex.noContext;

export interface RolloutUsage {
  modelId?: string;
  window?: number;
  usedTokens: number;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * Pure: scan rollout JSONL lines and extract the latest usage signal.
 *
 * - latest `token_count` (`payload.info.last_token_usage.total_tokens`) → `usedTokens`, with its
 *   `payload.info.model_context_window` → `window`;
 * - latest `turn_context` (`payload.model`) → `modelId`;
 * - `task_started` (`payload.model_context_window`, no `info`) → fallback window;
 * - broken/empty lines are skipped (try/catch per line); `usedTokens` defaults to 0.
 *
 * Window occupancy = `total_tokens` of the last request (input + output), validated against real
 * rollouts (ADR-0008 follow-up): the generated output rolls into the next request's input, so
 * `input_tokens` alone undercounts by the last turn's output. Fallback `input_tokens (+output_tokens)`
 * when `total_tokens` is absent. `cached_input_tokens` is a SUBSET of `input_tokens` - never added.
 */
export function parseRolloutUsage(lines: string[]): RolloutUsage {
  let tokenCountUsed: number | undefined;
  let tokenCountWindow: number | undefined;
  let taskStartedWindow: number | undefined;
  let modelId: string | undefined;

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // tolerate a corrupt line, keep scanning
    }
    const payload = obj?.payload ?? obj;
    if (!payload || typeof payload !== "object") continue;

    // token_count: usage + active window (latest wins).
    const info = payload.info;
    if (info && typeof info === "object") {
      const lt = info.last_token_usage;
      if (lt && typeof lt === "object") {
        let used: number | undefined;
        if (isNum(lt.total_tokens)) used = lt.total_tokens;
        else if (isNum(lt.input_tokens)) used = lt.input_tokens + (isNum(lt.output_tokens) ? lt.output_tokens : 0);
        if (used != null) {
          tokenCountUsed = used;
          if (isNum(info.model_context_window)) tokenCountWindow = info.model_context_window;
        }
      }
    }

    // turn_context: model slug (latest wins).
    if (isStr(payload.model)) modelId = payload.model;

    // task_started fallback window (latest wins) - top-level field, not inside `info`.
    if (isNum(payload.model_context_window)) taskStartedWindow = payload.model_context_window;
  }

  return {
    modelId,
    window: tokenCountWindow ?? taskStartedWindow,
    usedTokens: tokenCountUsed ?? 0,
  };
}

/**
 * Pure: map a parsed rollout usage onto the existing statusline renderer (ADR-0003 surface-relative).
 * The rollout's window becomes the surface cap; `modelId` doubles as the display name so the line
 * reads e.g. `🟢 8% ctx · gpt-5.5`.
 */
export function renderCodexStatusLine(usage: RolloutUsage, lang: Lang = "en"): string {
  return renderStatusline(
    {
      model: { id: usage.modelId, display_name: usage.modelId },
      context_window: { total_tokens: usage.window, input_tokens: usage.usedTokens },
    },
    lang,
  );
}

/**
 * Resolve the Codex sessions directory. Override order: `CAIRN_CODEX_SESSIONS` (direct) →
 * `CODEX_HOME` (its `sessions/` subdir) → `~/.codex/sessions`. Cross-platform via `homedir()`/`join`.
 */
export function codexSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (isStr(env.CAIRN_CODEX_SESSIONS)) return env.CAIRN_CODEX_SESSIONS;
  if (isStr(env.CODEX_HOME)) return join(env.CODEX_HOME, "sessions");
  return join(homedir(), ".codex", "sessions");
}

interface RolloutCandidate {
  path: string;
  mtimeMs: number;
}

/** First non-empty line of a file (where Codex writes `session_meta`); "" if unreadable. */
function firstLine(path: string): string {
  try {
    const raw = readFileSync(path, "utf8");
    const nl = raw.indexOf("\n");
    return (nl === -1 ? raw : raw.slice(0, nl)).trim();
  } catch {
    return "";
  }
}

/** `session_meta.id` (session UUID) + `cwd` from a rollout file, if present. */
function rolloutMeta(path: string): { id?: string; cwd?: string } {
  const line = firstLine(path);
  if (!line) return {};
  try {
    const obj = JSON.parse(line);
    const pl = obj?.payload ?? obj;
    return { id: isStr(pl?.id) ? pl.id : undefined, cwd: isStr(pl?.cwd) ? pl.cwd : undefined };
  } catch {
    return {};
  }
}

/** Gather all `*.jsonl` rollouts under `sessionsDir`, newest first; [] if the dir is absent. */
function gatherCandidates(sessionsDir: string): RolloutCandidate[] {
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir, { recursive: true }) as string[];
  } catch {
    return []; // directory absent
  }
  const candidates: RolloutCandidate[] = [];
  for (const rel of entries) {
    if (!rel.endsWith(".jsonl")) continue;
    const full = join(sessionsDir, rel);
    try {
      const st = statSync(full);
      if (st.isFile()) candidates.push({ path: full, mtimeMs: st.mtimeMs });
    } catch {
      // race: file vanished between readdir and stat - skip it
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates;
}

/**
 * IO: pick the active rollout file.
 * - `opts.sessionMatch` (explicit pin) wins: the newest rollout whose PATH contains the match
 *   (session UUID or any substring). Returns null if nothing matches - never falls back to a
 *   different session, so a pin is deterministic.
 * - else, when `opts.cwd` is given, prefer the newest whose `session_meta.cwd` matches.
 * - else the newest by mtime.
 *
 * Returns null if the directory is missing or holds no rollout. The cwd scan is capped to the newest
 * CWD_SCAN_LIMIT candidates to stay cheap with many sessions (ADR-0008: heuristic, best-effort).
 */
const CWD_SCAN_LIMIT = 25;

export function findActiveRollout(
  sessionsDir: string,
  opts: { cwd?: string; sessionMatch?: string } = {},
): string | null {
  const candidates = gatherCandidates(sessionsDir);
  if (candidates.length === 0) return null;

  if (isStr(opts.sessionMatch)) {
    const m = opts.sessionMatch;
    const hit = candidates.find((c) => c.path.includes(m));
    return hit ? hit.path : null; // deterministic pin: no match → no wrong-session fallback
  }

  if (isStr(opts.cwd)) {
    const limit = Math.min(candidates.length, CWD_SCAN_LIMIT);
    for (let i = 0; i < limit; i++) {
      if (rolloutMeta(candidates[i].path).cwd === opts.cwd) return candidates[i].path;
    }
  }
  return candidates[0].path;
}

export interface RolloutSummary {
  id: string; // session UUID (from session_meta.id, else the filename)
  cwd?: string;
  statusLine: string;
}

/** IO: summarize the newest rollouts (UUID + cwd + zone line) so a user can pick one to pin. */
const LIST_LIMIT = 10;

export function listRollouts(
  sessionsDir: string,
  opts: { limit?: number } = {},
  lang: Lang = "en",
): RolloutSummary[] {
  const candidates = gatherCandidates(sessionsDir);
  const limit = Math.min(candidates.length, opts.limit ?? LIST_LIMIT);
  const out: RolloutSummary[] = [];
  for (let i = 0; i < limit; i++) {
    const c = candidates[i];
    const meta = rolloutMeta(c.path);
    let statusLine: string;
    try {
      statusLine = renderCodexStatusLine(parseRolloutUsage(readFileSync(c.path, "utf8").split(/\r?\n/)), lang);
    } catch {
      statusLine = t(lang).codex.noContext;
    }
    out.push({ id: meta.id ?? basename(c.path), cwd: meta.cwd, statusLine });
  }
  return out;
}

/**
 * Resolve the session pin: explicit `opts.sessionMatch` wins, else `CAIRN_CODEX_SESSION` from env.
 */
function resolveSessionMatch(opts: { sessionMatch?: string; env?: NodeJS.ProcessEnv }): string | undefined {
  if (isStr(opts.sessionMatch)) return opts.sessionMatch;
  const env = opts.env ?? process.env;
  return isStr(env.CAIRN_CODEX_SESSION) ? env.CAIRN_CODEX_SESSION : undefined;
}

/**
 * IO glue: read the active rollout and render the one-line zone status. Returns the
 * `NO_CONTEXT_LINE` fallback when no rollout is available; never throws (any IO error → fallback).
 * Honors a session pin via `opts.sessionMatch` or the `CAIRN_CODEX_SESSION` env var.
 */
export function readCodexStatusLine(
  opts: { sessionsDir?: string; cwd?: string; env?: NodeJS.ProcessEnv; sessionMatch?: string } = {},
  lang: Lang = "en",
): string {
  const fallback = t(lang).codex.noContext;
  try {
    const dir = opts.sessionsDir ?? codexSessionsDir(opts.env);
    const cwd = opts.cwd ?? process.cwd();
    const sessionMatch = resolveSessionMatch(opts);
    const file = findActiveRollout(dir, { cwd, sessionMatch });
    if (!file) return fallback;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    return renderCodexStatusLine(parseRolloutUsage(lines), lang);
  } catch {
    return fallback;
  }
}
