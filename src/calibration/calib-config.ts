/**
 * Cairn - calibration run configuration (ADR-0005, ADR-0012).
 *
 * `cli.ts` runs `main()` on import, so the run configuration lives here as a pure function of env and
 * argv: unit-testable, and every check runs BEFORE any model call. `--real` and `--dry-run` share one
 * configuration; the dry run swaps in the fixture compactor and the heuristic reviewer and only counts
 * the calls a live run would make.
 *
 * ADR-0012 rules enforced here: candidates are pool models at exactly `high`; reviewers are pool models
 * (base ids) at exactly `high`; by default every brief is reviewed by all other pool models (full
 * matrix, k = pool - 1). Suspended models are rejected here - not in the compactor or reviewer, which
 * stay usable with any id.
 */

import { PROFILES, type ModelProfile } from "../core/model-profiles.js";
import type { Env } from "../core/env.js";
import {
  buildVariants,
  parseVariant,
  variantId,
  assertMinEffort,
  assertExactEffort,
  CALIB_EFFORT,
  type CalibEcosystem,
} from "./variants.js";
import { reviewerPromptSha256 } from "./model-reviewer.js";

/** The calibration pool = the summarizer pool (ADR-0012). Every model here is also a reviewer. */
export const CALIB_POOL = [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-luna",
] as const;

/** High-fill probe candidates: the whole pool at `high`. The window pre-filter drops the models whose
 *  bridge window cannot hold the probe (GPT-6 via Codex at the measured 258,400). */
export const LARGE_VARIANTS: readonly string[] = CALIB_POOL.map((id) => variantId(id, CALIB_EFFORT));
/** High-fill reviewers: the whole pool (reviewers only see the small brief, so GPT-6 can review). */
export const LARGE_REVIEWER_POOL: readonly string[] = CALIB_POOL;

export type CalibMode = "offline" | "dry-run" | "real";
export type CalibProbeKind = "single" | "golden" | "large";

export interface CalibConfig {
  mode: CalibMode;
  probe: CalibProbeKind;
  /** Live/dry run: `<model>@high` variant ids. Offline: profile ids (fixture compactor, effort unused). */
  candidates: string[];
  /** Live/dry run: base-model reviewer pool. Offline: undefined (the harness default). */
  reviewerPool?: string[];
  reviewersPerBrief: number;
  reviewerEffort: string;
  concurrency: number;
  timeoutMs: number;
  maxTokens: number;
  /** Large probe only: target probe size in tokens. */
  probeTokens?: number;
  /** `--rereview <golden.json>`: score that artifact's stored briefs again, no compaction (ADR-0012). */
  rereview?: string;
}

function list(raw: string | undefined): string[] | undefined {
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

/** A positive integer env value, or the default when unset. `Number("x")` would be NaN - with
 *  CAIRN_CALIB_REVIEWERS that meant zero reviewers - so anything else throws. */
function positiveInt(env: Env, name: string, def: number): number {
  const raw = env[name];
  if (raw == null || raw === "") return def;
  if (!/^[1-9]\d*$/.test(raw.trim())) throw new Error(`${name}: expected a positive integer, got '${raw}'`);
  return Number(raw.trim());
}

/** Throw unless `id` is an active pool model (ADR-0012: suspended models are never calibrated or reviewers). */
function assertPoolModel(id: string, profiles: ModelProfile[], label: string): void {
  const p = profiles.find((x) => x.id === id);
  if (!p) throw new Error(`${label}: unknown model '${id}'`);
  if (p.status !== "active") throw new Error(`${label}: '${id}' is ${p.status} (ADR-0012: only the current generation)`);
  if (!(CALIB_POOL as readonly string[]).includes(id)) {
    throw new Error(`${label}: '${id}' is not in the calibration pool (${CALIB_POOL.join(", ")})`);
  }
}

function ecosystemsFrom(raw: string | undefined): CalibEcosystem[] {
  const eco = list(raw) ?? ["anthropic", "openai"];
  for (const e of eco) {
    if (e !== "anthropic" && e !== "openai") throw new Error(`CAIRN_CALIB_ECOSYSTEMS: unknown ecosystem '${e}'`);
  }
  return eco as CalibEcosystem[];
}

/**
 * Resolve and validate the run configuration. Throws on any violation, so `cli.ts` aborts before the
 * first model call. Modes: `--real` (live), `--dry-run` (live config, no egress), else offline.
 * Probes: `--golden` (5-probe golden set; wins over `--probe`), `--probe large` /
 * `CAIRN_CALIB_PROBE=large` (high-fill, live/dry run only), else the single standard probe.
 * `--rereview <golden.json>` (live/dry run only) scores a golden artifact's stored briefs again.
 */
export function resolveCalibConfig(env: Env, argv: readonly string[], profiles: ModelProfile[] = PROFILES): CalibConfig {
  const real = argv.includes("--real");
  const dryRun = argv.includes("--dry-run");
  if (real && dryRun) throw new Error("--real and --dry-run exclude each other");
  const mode: CalibMode = real ? "real" : dryRun ? "dry-run" : "offline";
  const rr = argv.indexOf("--rereview");
  const rereview = rr >= 0 ? argv[rr + 1] : undefined;
  if (rr >= 0) {
    if (!rereview || rereview.startsWith("--")) throw new Error("--rereview needs the path of a golden artifact");
    const next = argv[rr + 2];
    if (argv.indexOf("--rereview", rr + 1) >= 0 || (next !== undefined && !next.startsWith("--"))) {
      throw new Error("--rereview takes one artifact per run");
    }
    if (mode === "offline") throw new Error("--rereview needs --real or --dry-run");
  }
  const golden = argv.includes("--golden") || rereview !== undefined;
  const idx = argv.indexOf("--probe");
  const large = env.CAIRN_CALIB_PROBE === "large" || (idx >= 0 && argv[idx + 1] === "large");
  if (rereview !== undefined && large) throw new Error("--rereview re-scores a golden artifact, not the high-fill probe");
  const explicit = list(env.CAIRN_CALIB_VARIANTS);

  if (mode === "offline") {
    // Fixture compactor + heuristic reviewer, no model call: the pre-ADR-0012 offline behaviour.
    const active = profiles.filter((p) => p.status === "active").map((p) => p.id);
    return {
      mode,
      probe: golden ? "golden" : "single",
      candidates: golden ? explicit ?? active : active,
      reviewersPerBrief: 2,
      reviewerEffort: CALIB_EFFORT,
      concurrency: 1,
      timeoutMs: 120_000,
      maxTokens: 4096,
    };
  }

  const probe: CalibProbeKind = golden ? "golden" : large ? "large" : "single";

  // Candidates: pool models at exactly `high`.
  let candidates: string[];
  if (probe === "large") {
    candidates = explicit ?? [...LARGE_VARIANTS];
  } else {
    candidates =
      explicit ??
      buildVariants({
        profiles,
        ecosystems: probe === "single" ? ecosystemsFrom(env.CAIRN_CALIB_ECOSYSTEMS) : ["anthropic", "openai"],
        efforts: { anthropic: list(env.CAIRN_CALIB_EFFORTS_ANTHROPIC), openai: list(env.CAIRN_CALIB_EFFORTS_OPENAI) },
      }).map((v) => v.id);
  }
  const label = explicit ? "CAIRN_CALIB_VARIANTS" : "candidate";
  for (const id of candidates) {
    const { baseModelId, effort } = parseVariant(id);
    assertExactEffort(effort, CALIB_EFFORT, `${label} '${id}'`);
    assertPoolModel(baseModelId, profiles, `${label} '${id}'`);
  }
  if (new Set(candidates).size !== candidates.length) throw new Error(`${label}: duplicate entries in ${candidates.join(",")}`);
  if (candidates.length === 0) throw new Error(`${label}: no candidate`);

  // Reviewers: base ids (an `x@high` entry would otherwise slip past the self-review filter), pool only.
  const rawPool = list(env.CAIRN_CALIB_REVIEWER_POOL);
  const reviewerPool = rawPool
    ? [...new Set(rawPool.map((id) => parseVariant(id).baseModelId))]
    : [...(probe === "large" ? LARGE_REVIEWER_POOL : CALIB_POOL)];
  for (const id of reviewerPool) assertPoolModel(id, profiles, "CAIRN_CALIB_REVIEWER_POOL");
  if (reviewerPool.length < 2) throw new Error("CAIRN_CALIB_REVIEWER_POOL: needs at least 2 models (no self-review)");

  // Full matrix by default: every brief gets all other pool models (k = pool - 1).
  const reviewersPerBrief = positiveInt(env, "CAIRN_CALIB_REVIEWERS", reviewerPool.length - 1);
  const reviewerEffort = assertExactEffort(env.CAIRN_CALIB_REVIEWER_EFFORT ?? CALIB_EFFORT, CALIB_EFFORT, "CAIRN_CALIB_REVIEWER_EFFORT");

  return {
    mode,
    probe,
    candidates,
    reviewerPool,
    reviewersPerBrief,
    reviewerEffort,
    concurrency: positiveInt(env, "CAIRN_CALIB_CONCURRENCY", probe === "large" ? 2 : 3),
    timeoutMs: positiveInt(env, "CAIRN_CALIB_TIMEOUT_MS", probe === "large" ? 900_000 : 120_000),
    maxTokens: positiveInt(env, "CAIRN_CALIB_MAXTOK", probe === "large" ? 8192 : 4096),
    ...(probe === "large" ? { probeTokens: positiveInt(env, "CAIRN_CALIB_PROBE_TOKENS", 800_000) } : {}),
    ...(rereview !== undefined ? { rereview } : {}),
  };
}

/**
 * Pre-flight for the live paths (ADR-0012), run in `cli.ts` right before the first model call:
 * every candidate and every LARGE_VARIANTS entry is at exactly `high` (so never below it), the
 * reviewers run at exactly `high`, and the reviewer pool holds base ids only.
 */
export function assertCalibPreflight(cfg: Pick<CalibConfig, "candidates" | "reviewerEffort" | "reviewerPool">): void {
  for (const id of [...cfg.candidates, ...LARGE_VARIANTS]) {
    const { effort } = parseVariant(id);
    assertMinEffort(effort, CALIB_EFFORT, `candidate '${id}'`);
    assertExactEffort(effort, CALIB_EFFORT, `candidate '${id}'`);
  }
  assertExactEffort(cfg.reviewerEffort, CALIB_EFFORT, "reviewer");
  for (const id of cfg.reviewerPool ?? []) {
    if (parseVariant(id).baseModelId !== id) throw new Error(`reviewer pool: '${id}' is not a base model id`);
  }
}

/** `reviewerPromptSha256` of a dry or offline run: its reviewer is the heuristic one, which has no prompt. */
export const HEURISTIC_REVIEWER = "heuristic";

/** What an artifact records as `reviewerPromptSha256` (ADR-0012): the model reviewer's prompt hash for a real
 *  run (with or without the source), `heuristic` otherwise, so `--pool` never mixes heuristic and model scores. */
export function reviewerPromptRecord(mode: CalibMode, withSource: boolean): string {
  return mode === "real" ? reviewerPromptSha256(withSource) : HEURISTIC_REVIEWER;
}

/** Artifact name suffix after the date: ISO time + mode (+ `rereview`) + probe, e.g. `T14-05-09Z-real-golden`
 *  or `T14-05-09Z-real-rereview-golden`. With `persistArtifact`'s write-once rule no run replaces another
 *  run's file. */
export function artifactSuffix(now: Date, mode: CalibMode, probe: CalibProbeKind, rereview = false): string {
  const time = now.toISOString().slice(10, 19).replace(/:/g, "-"); // "T14:05:09" → "T14-05-09"
  return `${time}Z-${mode}${rereview ? "-rereview" : ""}${probe === "single" ? "" : `-${probe}`}`;
}
