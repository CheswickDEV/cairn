/**
 * Cairn (AI Context Continuity Engine) - model-profiles + summarizer selector (scaffold)
 * ----------------------------------------------------------------
 * Implements the four locked-in decisions (see ADR-cairn.md):
 *   ADR-0002  fidelity-first selection, cost only as tiebreaker
 *   ADR-0003  context zones relative to the ACTIVE surface window (provisional 40/70/100)
 *   ADR-0004  ecosystem filter -> reachability -> quality rank -> verbatim floor
 *
 * This is the domain core that will live inside the MCP server (ADR-0001):
 *   - `context_status` tool  -> uses activeWindow() + zoneBoundaries() + classifyZone()
 *   - `handoff` tool         -> uses selectSummarizer() to pick the model (or verbatim)
 *
 * Pricing/context values are sourced (June 2026). Quality zones for Opus 4.8 / GPT-5.5 are PROVISIONAL
 * house values (no vendor %); replace with benchmarks when available.
 * `fidelityScore` / `verbosityCoeff` are NOT vendor-derivable -> calibrate via golden-set (ADR-0005).
 *
 * NOTE (ADR-0006): default runtime is ACCOUNT mode - the host agent (Claude Code / Codex) runs the
 * compaction on the user's own subscription; this server makes no model call and needs no API key.
 * In account mode, "reachability" = can the active session/account invoke this model, and per-token
 * price is informational (the relevant constraint is the account usage limit). The price fields here
 * drive the OPTIONAL API/Bridge mode and the relative token-efficiency tiebreaker only.
 */

import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

export const Ecosystem = z.enum(["anthropic", "openai", "local", "generic"]);
export type Ecosystem = z.infer<typeof Ecosystem>;

export const Zone = z.enum(["green", "yellow", "red"]);
export type Zone = z.infer<typeof Zone>;

const Source = z.object({
  label: z.string(),
  url: z.string().optional(),
  date: z.string(), // ISO yyyy-mm
});

/** Long-context surcharge: above `stdThreshold` input tokens the WHOLE session
 *  is billed at these multipliers. `null` threshold = flat pricing (no surcharge). */
const Surcharge = z.object({
  inputMult: z.number().min(1),
  outputMult: z.number().min(1),
});

const Price = z.object({
  inputPerMTok: z.number(),
  outputPerMTok: z.number(),
  cacheReadPerMTok: z.number().optional(),
  batchInputPerMTok: z.number().optional(),
  batchOutputPerMTok: z.number().optional(),
});

const ContextSpec = z.object({
  window: z.number().int(),                       // native max input window
  maxOutput: z.number().int(),
  stdThreshold: z.number().int().nullable(),       // null = flat (no long-ctx surcharge)
  surcharge: Surcharge.nullable(),                 // applies above stdThreshold
});

/** Quality zone fractions of the ACTIVE window (red is implicitly yellowPct..1.0). */
const QualityZone = z.object({
  greenPct: z.number().min(0).max(1),
  yellowPct: z.number().min(0).max(1),
  provisional: z.boolean(),
});

const Summarizer = z.object({
  fidelityScore: z.number().min(0).max(1).nullable(), // measured; null = uncalibrated
  verbosityCoeff: z.number().min(0),                  // brief tokens vs baseline (1.0 = baseline)
  provisionalFidelity: z.number().min(0).max(1),       // provisional 0..1 estimate until calibrated
  calibrated: z.boolean(),
  // --- T3 additive (ADR-0005): written by the calibration harness; optional so existing
  //     seed profiles remain valid (they stay provisional/uncalibrated until a run). ---
  calibrationDate: z.string().optional(),              // ISO date of the calibration run that set the scores
  confidence: z.number().min(0).max(1).optional(),     // reviewer agreement (1 - spread); low = high disagreement
  effort: z.string().optional(),                       // reasoning-effort tier that won calibration for this model
});

export const ModelProfile = z.object({
  id: z.string(),
  displayName: z.string(),
  ecosystem: Ecosystem,
  status: z.enum(["active", "suspended", "preview"]),
  isPro: z.boolean().default(false),                  // separate pricier model id (gpt-*-pro)
  price: Price,
  context: ContextSpec,
  qualityZone: QualityZone,
  summarizer: Summarizer,
  sources: z.array(Source),
  notes: z.string().optional(),
});
export type ModelProfile = z.infer<typeof ModelProfile>;

/* ------------------------------------------------------------------ */
/* Seed data - June 2026 standard set                                  */
/* ------------------------------------------------------------------ */

const VENDOR = (label: string, url: string, date: string) => ({ label, url, date });

export const PROFILES: ModelProfile[] = [
  // ---- Anthropic ----
  {
    id: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    ecosystem: "anthropic",
    status: "active",
    isPro: false,
    price: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, batchInputPerMTok: 2.5, batchOutputPerMTok: 12.5 },
    context: { window: 1_000_000, maxOutput: 128_000, stdThreshold: null, surcharge: null }, // flat across 1M
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true },
    summarizer: { fidelityScore: 0.966, verbosityCoeff: 0.96, provisionalFidelity: 0.92, calibrated: true, calibrationDate: "2026-06-22", confidence: 0.98, effort: "max" },
    sources: [VENDOR("Anthropic pricing docs", "https://platform.claude.com/docs/en/about-claude/pricing", "2026-06")],
    notes: "Flat pricing across full 1M (no >200k surcharge, unlike 4.6/4.7). Effort defaults to 'high'.",
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    ecosystem: "anthropic",
    status: "active",
    isPro: false,
    price: { inputPerMTok: 3, outputPerMTok: 15, batchInputPerMTok: 1.5, batchOutputPerMTok: 7.5 },
    context: { window: 1_000_000, maxOutput: 128_000, stdThreshold: null, surcharge: null },
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true }, // inherits 1M house values
    summarizer: { fidelityScore: 0.974, verbosityCoeff: 0.97, provisionalFidelity: 0.85, calibrated: true, calibrationDate: "2026-06-22", confidence: 0.98, effort: "high" },
    sources: [VENDOR("Anthropic pricing docs", "https://platform.claude.com/docs/en/about-claude/pricing", "2026-06")],
  },
  {
    id: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    ecosystem: "anthropic",
    status: "active",
    isPro: false,
    price: { inputPerMTok: 1, outputPerMTok: 5, batchInputPerMTok: 0.5, batchOutputPerMTok: 2.5 },
    context: { window: 200_000, maxOutput: 64_000, stdThreshold: null, surcharge: null },
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true }, // same % inherited to 200k window
    summarizer: { fidelityScore: 0.980, verbosityCoeff: 0.78, provisionalFidelity: 0.70, calibrated: true, calibrationDate: "2026-06-22", confidence: 0.98, effort: "xhigh" },
    sources: [VENDOR("Anthropic pricing docs", "https://platform.claude.com/docs/en/about-claude/pricing", "2026-06")],
    notes: "Cheapest, but small-model + complex 7-bucket prompt is the risk case — must clear floor before use as default.",
  },
  {
    id: "claude-fable-5",
    displayName: "Claude Fable 5",
    ecosystem: "anthropic",
    status: "suspended", // currently offline per export-control directive
    isPro: false,
    price: { inputPerMTok: 10, outputPerMTok: 50 },
    context: { window: 1_000_000, maxOutput: 128_000, stdThreshold: null, surcharge: null },
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true },
    summarizer: { fidelityScore: null, verbosityCoeff: 1.0, provisionalFidelity: 0.93, calibrated: false },
    sources: [VENDOR("Anthropic pricing review", "https://www.anthropic.com/news/fable-mythos-access", "2026-06")],
    notes: "Known but currently unavailable. Placeholder entry; not selectable while status=suspended.",
  },

  // ---- OpenAI ----
  {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    ecosystem: "openai",
    status: "active",
    isPro: false,
    price: { inputPerMTok: 5, outputPerMTok: 30, cacheReadPerMTok: 0.5, batchInputPerMTok: 2.5, batchOutputPerMTok: 15 },
    context: { window: 1_000_000, maxOutput: 128_000, stdThreshold: 272_000, surcharge: { inputMult: 2, outputMult: 1.5 } },
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true },
    summarizer: { fidelityScore: 0.971, verbosityCoeff: 1.1, provisionalFidelity: 0.90, calibrated: true, calibrationDate: "2026-06-22", confidence: 0.98, effort: "xhigh" },
    sources: [VENDOR("OpenAI model docs", "https://developers.openai.com/api/docs/models/gpt-5.5", "2026-06")],
    notes: "Reasoning effort (none/low/medium/high/xhigh) does NOT change per-token price — token-volume lever only. Codex surface windows are plan/client dependent; current rollout telemetry observed 258400, so pass the host-reported surfaceCap.",
  },
  {
    id: "gpt-5.5-pro",
    displayName: "GPT-5.5 Pro",
    ecosystem: "openai",
    status: "active",
    isPro: true,
    price: { inputPerMTok: 30, outputPerMTok: 180 },
    context: { window: 1_000_000, maxOutput: 128_000, stdThreshold: 272_000, surcharge: { inputMult: 2, outputMult: 1.5 } },
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true },
    summarizer: { fidelityScore: null, verbosityCoeff: 1.0, provisionalFidelity: 0.91, calibrated: false },
    sources: [VENDOR("OpenAI / model-drop reporting", "https://developers.openai.com/api/docs/models/gpt-5.5", "2026-06")],
    notes: "Separate model id, 6x the standard rate. Covers consumer 'pro standard'/'pro erweitert'. Tiebreaker should avoid unless fidelity gap is real.",
  },
  {
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    ecosystem: "openai",
    status: "active",
    isPro: false,
    price: { inputPerMTok: 2.5, outputPerMTok: 15, batchInputPerMTok: 1.25, batchOutputPerMTok: 7.5 },
    context: { window: 1_050_000, maxOutput: 128_000, stdThreshold: 272_000, surcharge: { inputMult: 2, outputMult: 1 } },
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true },
    summarizer: { fidelityScore: 0.973, verbosityCoeff: 1.16, provisionalFidelity: 0.82, calibrated: true, calibrationDate: "2026-06-22", confidence: 0.98, effort: "high" },
    sources: [VENDOR("GPT-5.4 API guide", "https://www.nxcode.io/resources/news/gpt-5-4-api-developer-guide-reasoning-computer-use-2026", "2026-03")],
    notes: "Output surcharge multiplier above 272k not clearly documented; set to 1 (input doubles). Verify before relying on long-ctx output cost. Effort 'high': the 5-probe golden set (2026-06-22) showed high ≥ xhigh (0.989 vs 0.984, within the ADR-0002 band) AND high is cheaper — strictly dominant. fidelityScore kept on the single-probe calibration basis for cross-profile comparability.",
  },
  {
    id: "gpt-5.4-pro",
    displayName: "GPT-5.4 Pro",
    ecosystem: "openai",
    status: "active",
    isPro: true,
    price: { inputPerMTok: 30, outputPerMTok: 180 },
    context: { window: 1_050_000, maxOutput: 128_000, stdThreshold: 272_000, surcharge: { inputMult: 2, outputMult: 1 } },
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true },
    summarizer: { fidelityScore: null, verbosityCoeff: 1.0, provisionalFidelity: 0.83, calibrated: false },
    sources: [VENDOR("GPT-5.4 API guide", "https://www.nxcode.io/resources/news/gpt-5-4-api-developer-guide-reasoning-computer-use-2026", "2026-03")],
  },

  // ---- Local / universal fallback ----
  {
    id: "ollama:local",
    displayName: "Ollama (local)",
    ecosystem: "local",
    status: "active",
    isPro: false,
    price: { inputPerMTok: 0, outputPerMTok: 0 }, // local compute, no per-token egress cost
    context: { window: 128_000, maxOutput: 32_000, stdThreshold: null, surcharge: null }, // depends on the served model; override at runtime
    qualityZone: { greenPct: 0.50, yellowPct: 0.70, provisional: true }, // conservative general fallback
    summarizer: { fidelityScore: null, verbosityCoeff: 1.0, provisionalFidelity: 0.60, calibrated: false },
    sources: [VENDOR("internal", "", "2026-06")],
    notes: "Only account-free universal fallback (lokal-privat). Window/fidelity depend on the served model — calibrate per deployment.",
  },
];

/** Conservative profile for any model not explicitly listed (ADR-0003 general fallback). */
export const GENERIC_FALLBACK: ModelProfile = ModelProfile.parse({
  id: "generic:unknown",
  displayName: "Unknown model (generic fallback)",
  ecosystem: "generic",
  status: "active",
  isPro: false,
  price: { inputPerMTok: 0, outputPerMTok: 0 },
  context: { window: 128_000, maxOutput: 16_000, stdThreshold: null, surcharge: null },
  qualityZone: { greenPct: 0.50, yellowPct: 0.70, provisional: true },
  summarizer: { fidelityScore: null, verbosityCoeff: 1.2, provisionalFidelity: 0.50, calibrated: false },
  sources: [VENDOR("internal default", "", "2026-06")],
});

// Validate all seed data against the schema at load time.
PROFILES.forEach((p) => ModelProfile.parse(p));

/**
 * Normalise a host-reported model id: strip real-world decorations that break exact matching -
 * a trailing `[1m]`/`(…)` (Claude Code's 1M-context suffix), an `@effort` variant, and a
 * provider/region prefix like `us.anthropic.` / `openai/` (Bedrock/Vertex). Lower-cased.
 */
export function normalizeModelId(id: string): string {
  let s = id.trim().toLowerCase();
  s = s.replace(/[[(][^\])]*[\])]\s*$/, ""); // trailing "[1m]" / "(…)"
  s = s.replace(/@[^@]*$/, ""); // trailing "@effort"
  s = s.replace(/^(?:[a-z]{2,4}\.)?(?:anthropic|openai|google|meta|bedrock|vertex)[./]/, ""); // provider/region prefix
  return s.trim();
}

/**
 * Deprecated model ids → the profile they migrated to (separator-bounded prefix match), so old
 * sessions still render against a sensible window instead of the 128k generic fallback.
 */
const PROFILE_ALIASES: Record<string, string> = {
  "gpt-5.3": "gpt-5.4", // Codex migration notice: gpt-5.3-codex → gpt-5.4
};

/** Is `next` a token boundary (end / separator) after a prefix match? */
function isBoundary(next: string): boolean {
  return next === "" || next === "-" || next === ":" || next === ".";
}

/**
 * Resolve a host-reported model id to a profile, tolerant of id decorations exact matching misses -
 * so the statusline/context_status don't silently fall back to `generic:unknown` (wrong window +
 * zones). Handles `claude-opus-4-8[1m]`, Codex slugs like `gpt-5.5-codex`/dated suffixes,
 * Bedrock/Vertex prefixes, date-suffixed profile ids the host omits (`claude-haiku-4-5` →
 * `claude-haiku-4-5-20251001`), and deprecated-model aliases. Strategy: exact → normalised-exact →
 * longest separator-bounded profile-prefix → date-suffix reverse match → alias → GENERIC_FALLBACK.
 */
export function resolveProfile(id: string | undefined, profiles: ModelProfile[] = PROFILES): ModelProfile {
  if (!id) return GENERIC_FALLBACK;
  const exact = profiles.find((p) => p.id === id);
  if (exact) return exact;
  const norm = normalizeModelId(id);
  if (!norm) return GENERIC_FALLBACK;
  const normExact = profiles.find((p) => p.id.toLowerCase() === norm);
  if (normExact) return normExact;
  // forward: profile id is a separator-bounded prefix of the model id (gpt-5.5-codex → gpt-5.5)
  const byPrefix = profiles
    .filter((p) => norm.startsWith(p.id.toLowerCase()) && isBoundary(norm.charAt(p.id.length)))
    .sort((a, b) => b.id.length - a.id.length)[0];
  if (byPrefix) return byPrefix;
  // reverse: profile carries a DATE suffix the host omits (date-like only, so `-pro`/`-codex` never collapse)
  const byDate = profiles.find((p) => {
    const pid = p.id.toLowerCase();
    return pid.startsWith(norm + "-") && /^\d[\d-]*$/.test(pid.slice(norm.length + 1));
  });
  if (byDate) return byDate;
  // alias: deprecated id → migration target (separator-bounded prefix, e.g. gpt-5.3-codex → gpt-5.4)
  const aliasKey = Object.keys(PROFILE_ALIASES)
    .filter((k) => norm.startsWith(k) && isBoundary(norm.charAt(k.length)))
    .sort((a, b) => b.length - a.length)[0];
  if (aliasKey) {
    const target = profiles.find((p) => p.id === PROFILE_ALIASES[aliasKey]);
    if (target) return target;
  }
  return GENERIC_FALLBACK;
}

/**
 * Fidelity floor (ADR-0004/0005): below this a model must NOT compact → verbatim fallback.
 * Set from the 2026-06-22 cross-ecosystem calibration: the five reachable models measured
 * 0.966–0.980 (best effort); 0.85 sits comfortably below them (clears even the red-zone +0.10
 * escalation) while keeping the local/generic fallbacks (≤0.60) below it. Manually confirmed.
 */
export const FIDELITY_FLOOR = 0.85;

/* ------------------------------------------------------------------ */
/* Context zones (ADR-0003)                                            */
/* ------------------------------------------------------------------ */

/** Effective working window = the smallest of model max, surface cap, and any user override. */
export function activeWindow(p: ModelProfile, opts: { surfaceCap?: number; userOverride?: number } = {}): number {
  return Math.min(
    p.context.window,
    opts.surfaceCap ?? Infinity,
    opts.userOverride ?? Infinity,
  );
}

export interface ZoneBoundaries {
  window: number;
  greenUntil: number; // tokens
  yellowUntil: number;
  redUntil: number;
}

/** Boundaries in tokens, relative to the ACTIVE window, optionally tightened by a usecase noise factor (<=1). */
export function zoneBoundaries(p: ModelProfile, win: number, noiseFactor = 1): ZoneBoundaries {
  const nf = Math.max(0, Math.min(1, noiseFactor));
  return {
    window: win,
    greenUntil: Math.round(win * p.qualityZone.greenPct * nf),
    yellowUntil: Math.round(win * p.qualityZone.yellowPct * nf),
    redUntil: win,
  };
}

export function classifyZone(usedTokens: number, b: ZoneBoundaries): Zone {
  if (usedTokens <= b.greenUntil) return "green";
  if (usedTokens <= b.yellowUntil) return "yellow";
  return "red";
}

/* ------------------------------------------------------------------ */
/* Effective cost (ADR-0002 tiebreaker)                                */
/* ------------------------------------------------------------------ */

export interface CostInput {
  inputTokens: number;
  expectedBriefTokens: number; // model emits ~this many output tokens for the brief
  useBatch?: boolean;
}

/** USD for one compaction call. Accounts for the long-context surcharge and the
 *  model's token-efficiency (verbosityCoeff scales emitted brief tokens). */
export function effectiveCost(p: ModelProfile, c: CostInput): number {
  const perM = (n: number, rate: number) => (n / 1_000_000) * rate;

  let inRate = c.useBatch && p.price.batchInputPerMTok != null ? p.price.batchInputPerMTok : p.price.inputPerMTok;
  let outRate = c.useBatch && p.price.batchOutputPerMTok != null ? p.price.batchOutputPerMTok : p.price.outputPerMTok;

  // Long-context surcharge applies to the WHOLE session above the threshold.
  if (p.context.stdThreshold != null && c.inputTokens > p.context.stdThreshold && p.context.surcharge) {
    inRate *= p.context.surcharge.inputMult;
    outRate *= p.context.surcharge.outputMult;
  }

  const briefTokens = c.expectedBriefTokens * p.summarizer.verbosityCoeff;
  return perM(c.inputTokens, inRate) + perM(briefTokens, outRate);
}

/* ------------------------------------------------------------------ */
/* Environment detection (ADR-0004 stage 0)                            */
/* ------------------------------------------------------------------ */

export interface HostSignal {
  /** e.g. Claude Code statusline `model.id`, or Codex `model_provider`. */
  modelId?: string;
  provider?: string;
}

export function detectEcosystem(h: HostSignal): Ecosystem {
  const id = (h.modelId ?? "").toLowerCase();
  const prov = (h.provider ?? "").toLowerCase();
  if (prov === "ollama" || prov === "lmstudio" || id.startsWith("ollama")) return "local";
  if (id.startsWith("claude") || prov === "anthropic" || prov === "bedrock") return "anthropic";
  if (id.startsWith("gpt") || prov === "openai") return "openai";
  return "generic";
}

/* ------------------------------------------------------------------ */
/* Reachability probe (ADR-0004) - interface + default stub           */
/* ------------------------------------------------------------------ */

/** Real impl issues a tiny credential/capability ping per candidate (cached).
 *  Default stub treats every active, non-suspended candidate as reachable. */
export type ReachabilityProbe = (p: ModelProfile) => Promise<boolean>;
export const defaultReachable: ReachabilityProbe = async (p) => p.status === "active";

/* ------------------------------------------------------------------ */
/* Summarizer selection (ADR-0002 + 0003 + 0004)                       */
/* ------------------------------------------------------------------ */

export interface SelectInput {
  host: HostSignal;
  sourceZone: Zone;          // zone of the conversation being compacted (drives escalation)
  cost: CostInput;
  fidelityFloor: number;     // 0..1 - below this a model must NOT compact
  allowCrossProvider?: boolean; // only true if org explicitly wired another provider
  profiles?: ModelProfile[];
  reachable?: ReachabilityProbe;
}

export type SelectResult =
  | { kind: "model"; model: ModelProfile; estCostUsd: number; reason: string }
  | { kind: "verbatim-fallback"; reason: string };

/** Effective fidelity (0..1) for ranking: measured score if calibrated, else the
 *  provisional estimate (ADR-0002: provisional ordering until golden-set calibration). */
function fidelityKey(p: ModelProfile): number {
  if (p.summarizer.calibrated && p.summarizer.fidelityScore != null) return p.summarizer.fidelityScore;
  return p.summarizer.provisionalFidelity;
}

export async function selectSummarizer(input: SelectInput): Promise<SelectResult> {
  const all = input.profiles ?? PROFILES;
  const reachable = input.reachable ?? defaultReachable;
  const ecosystem = detectEcosystem(input.host);

  // Stage 1: ecosystem filter (no cross-provider unless explicitly allowed).
  let pool = all.filter((p) => p.status === "active");
  if (!input.allowCrossProvider) {
    pool = pool.filter((p) => p.ecosystem === ecosystem || p.ecosystem === "local");
  }
  if (pool.length === 0) {
    return { kind: "verbatim-fallback", reason: `no active model in ecosystem '${ecosystem}'` };
  }

  // Stage 2: reachability (credentials/scope/tier).
  const reach = await Promise.all(pool.map((p) => reachable(p)));
  pool = pool.filter((_, i) => reach[i]);
  if (pool.length === 0) {
    return { kind: "verbatim-fallback", reason: `no reachable model in ecosystem '${ecosystem}'` };
  }

  // Stage 3: quality-first. Take the TOP fidelity band, then pick the cheapest within it.
  // This is ADR-0002 in one rule: cost only decides among statistically-equal-fidelity models,
  // so a model is never downgraded for cost outside the equivalence band - and we never pay 6x
  // for a Pro sibling that is not measurably more faithful.
  const FIDELITY_BAND = 0.02; // models within this delta count as equivalent fidelity
  const maxF = Math.max(...pool.map(fidelityKey));
  const topBand = pool.filter((p) => maxF - fidelityKey(p) <= FIDELITY_BAND);
  const chosen = [...topBand].sort((a, b) => effectiveCost(a, input.cost) - effectiveCost(b, input.cost))[0];

  // Stage 4: fidelity floor - zone escalation RAISES the floor (harder source context demands a
  // stronger summarizer). If even the top-band model can't clear the effective floor, go verbatim.
  const ESCALATION_BUMP: Record<Zone, number> = { green: 0, yellow: 0.05, red: 0.10 };
  const effectiveFloor = input.fidelityFloor + ESCALATION_BUMP[input.sourceZone];
  if (fidelityKey(chosen) < effectiveFloor) {
    return {
      kind: "verbatim-fallback",
      reason: `best available '${chosen.id}' (fidelity ${fidelityKey(chosen).toFixed(3)}) below ` +
              `effective floor ${effectiveFloor.toFixed(3)} in ${input.sourceZone} zone ` +
              `— emitting lossless verbatim handoff instead`,
    };
  }

  const estCostUsd = effectiveCost(chosen, input.cost);
  const note = chosen.summarizer.calibrated ? "calibrated" : "PROVISIONAL rank (uncalibrated)";
  return {
    kind: "model",
    model: chosen,
    estCostUsd,
    reason: `${ecosystem} ecosystem, ${input.sourceZone} zone, ${note}`,
  };
}
