/**
 * Cairn (AI Context Continuity Engine) — model-profiles + summarizer selector (scaffold)
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
 * NOTE (ADR-0006): default runtime is ACCOUNT mode — the host agent (Claude Code / Codex) runs the
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
/* Seed data — June 2026 standard set                                  */
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
    summarizer: { fidelityScore: null, verbosityCoeff: 1.0, provisionalFidelity: 0.92, calibrated: false },
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
    summarizer: { fidelityScore: null, verbosityCoeff: 1.0, provisionalFidelity: 0.85, calibrated: false },
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
    summarizer: { fidelityScore: null, verbosityCoeff: 1.0, provisionalFidelity: 0.70, calibrated: false },
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
    summarizer: { fidelityScore: null, verbosityCoeff: 1.0, provisionalFidelity: 0.90, calibrated: false },
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
    summarizer: { fidelityScore: null, verbosityCoeff: 1.0, provisionalFidelity: 0.82, calibrated: false },
    sources: [VENDOR("GPT-5.4 API guide", "https://www.nxcode.io/resources/news/gpt-5-4-api-developer-guide-reasoning-computer-use-2026", "2026-03")],
    notes: "Output surcharge multiplier above 272k not clearly documented; set to 1 (input doubles). Verify before relying on long-ctx output cost.",
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
/* Reachability probe (ADR-0004) — interface + default stub           */
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
  fidelityFloor: number;     // 0..1 — below this a model must NOT compact
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
  // so a model is never downgraded for cost outside the equivalence band — and we never pay 6x
  // for a Pro sibling that is not measurably more faithful.
  const FIDELITY_BAND = 0.02; // models within this delta count as equivalent fidelity
  const maxF = Math.max(...pool.map(fidelityKey));
  const topBand = pool.filter((p) => maxF - fidelityKey(p) <= FIDELITY_BAND);
  const chosen = [...topBand].sort((a, b) => effectiveCost(a, input.cost) - effectiveCost(b, input.cost))[0];

  // Stage 4: fidelity floor — zone escalation RAISES the floor (harder source context demands a
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

/* ------------------------------------------------------------------ */
/* Demo                                                                */
/* ------------------------------------------------------------------ */

async function demo() {
  console.log("=== Zone math: % of ACTIVE window, not model max (ADR-0003) ===");
  const opus = PROFILES.find((p) => p.id === "claude-opus-4-8")!;
  const gpt = PROFILES.find((p) => p.id === "gpt-5.5")!;
  const haiku = PROFILES.find((p) => p.id === "claude-haiku-4-5-20251001")!;

  const cases: Array<[string, ModelProfile, { surfaceCap?: number }, number]> = [
    ["Opus 4.8 @ Claude Code (1M)", opus, {}, 0],
    ["Opus 4.8 @ Microsoft Foundry (200k cap)", opus, { surfaceCap: 200_000 }, 0],
    ["GPT-5.5 @ Codex (observed 258400 cap)", gpt, { surfaceCap: 258_400 }, 0],
    ["Haiku 4.5 (200k)", haiku, {}, 0],
  ];
  for (const [label, p, opts] of cases) {
    const win = activeWindow(p, opts);
    const b = zoneBoundaries(p, win);
    console.log(
      `  ${label.padEnd(42)} win=${win.toLocaleString()}  ` +
      `green<=${b.greenUntil.toLocaleString()}  yellow<=${b.yellowUntil.toLocaleString()}  red=${b.redUntil.toLocaleString()}`,
    );
  }

  console.log("\n  Tool-heavy session (noiseFactor 0.5) tightens the green zone:");
  const winN = activeWindow(opus);
  const tight = zoneBoundaries(opus, winN, 0.5);
  console.log(`  Opus 4.8 @1M  green<=${tight.greenUntil.toLocaleString()} (was ${zoneBoundaries(opus, winN).greenUntil.toLocaleString()})`);

  console.log("\n=== Effective cost: token efficiency matters (ADR-0002 tiebreaker) ===");
  const cost: CostInput = { inputTokens: 180_000, expectedBriefTokens: 6_000 };
  for (const id of ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-8"]) {
    const p = PROFILES.find((x) => x.id === id)!;
    console.log(`  ${p.displayName.padEnd(20)} $${effectiveCost(p, cost).toFixed(4)}  (batch: $${effectiveCost(p, { ...cost, useBatch: true }).toFixed(4)})`);
  }
  console.log("  Note: with verbosityCoeff calibrated, a denser model can undercut a 'cheaper' verbose one.");

  console.log("\n=== Selection: ecosystem filter + quality-first + floor (ADR-0004) ===");

  const inClaudeCode = await selectSummarizer({
    host: { modelId: "claude-opus-4-8" },
    sourceZone: "green",
    cost,
    fidelityFloor: 0.0, // floor disabled until calibrated; provisional ranks used
  });
  console.log("  Claude Code, green zone ->", render(inClaudeCode));

  const inCodexRed = await selectSummarizer({
    host: { provider: "openai", modelId: "gpt-5.5" },
    sourceZone: "red", // escalate: no cost downgrade
    cost,
    fidelityFloor: 0.0,
  });
  console.log("  Codex, RED zone (escalate) ->", render(inCodexRed));

  const claudeUserNoChatGPT = await selectSummarizer({
    host: { modelId: "claude-sonnet-4-6" }, // a Claude user — must NOT pick GPT
    sourceZone: "green",
    cost,
    fidelityFloor: 0.0,
  });
  console.log("  Claude user (no ChatGPT acct) ->", render(claudeUserNoChatGPT), "(GPT models excluded)");

  const onlyWeakReachable = await selectSummarizer({
    host: { modelId: "claude-haiku-4-5-20251001" },
    sourceZone: "red",
    cost,
    fidelityFloor: 0.75, // red bumps to 0.85; Haiku's 0.70 can't clear it -> verbatim
    reachable: async (p) => p.id === "claude-haiku-4-5-20251001", // only Haiku reachable
  });
  console.log("  Only weak model reachable, RED zone ->", render(onlyWeakReachable));
}

function render(r: SelectResult): string {
  return r.kind === "model"
    ? `${r.model.displayName} (est $${r.estCostUsd.toFixed(4)}; ${r.reason})`
    : `VERBATIM FALLBACK — ${r.reason}`;
}

// Run when executed directly (tsx / ts-node).
demo().catch((e) => { console.error(e); process.exit(1); });
