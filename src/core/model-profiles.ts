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
 * Pricing/context values are sourced (October 2026 for the summarizer pool - Claude Fable 5.1, Opus 5.5,
 * Sonnet 5.5, Haiku 5.5, GPT-6 Astra, GPT-6.1 Sol, GPT-6 Luna - and the context-only gpt-6-sol; June 2026
 * for the suspended earlier generation). Quality zones are PROVISIONAL house values (no vendor %);
 * replace with benchmarks when available.
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
  window: z.number().int(),                       // native context window, as the vendor documents it
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
/* Seed data - October 2026 pool + the suspended June 2026 set         */
/* ------------------------------------------------------------------ */

const VENDOR = (label: string, url: string, date: string) => ({ label, url, date });

/** Note suffix for the earlier generation (ADR-0012): never selected, calibrated or used as reviewer,
 *  but still resolvable so the statusline/context_status keep the right window. */
const SUSPENDED_2026_10 = "suspended 2026-10: focus on the current generation (ADR-0012); measured values kept as history.";

export const PROFILES: ModelProfile[] = [
  // ---- Anthropic: summarizer pool (ADR-0012) ----
  {
    id: "claude-fable-5-1",
    displayName: "Claude Fable 5.1",
    ecosystem: "anthropic",
    status: "active",
    isPro: false,
    price: { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 0.25, batchInputPerMTok: 5, batchOutputPerMTok: 25 },
    context: { window: 1_000_000, maxOutput: 128_000, stdThreshold: null, surcharge: null }, // flat across 1M
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true }, // inherits 1M house values
    summarizer: { fidelityScore: 0.9510, verbosityCoeff: 1.13, provisionalFidelity: 0.93, calibrated: true, calibrationDate: "2026-10-12", confidence: 0.98, effort: "high" },
    sources: [
      VENDOR("Anthropic Claude Fable 5.1 model page", "https://platform.claude.com/docs/en/models/fable-5-1/overview", "2026-10"),
      VENDOR("Anthropic pricing docs", "https://platform.claude.com/docs/en/about-claude/pricing", "2026-10"),
    ],
    notes: "Flat pricing across the full 1M; cache reads 0.025x base input. Default effort 'high' (API and Claude Code). " +
      "Calibrated 2026-10-12 (ADR-0012): golden-set mean of two pooled runs at effort 'high', all reviewers, " +
      "each reviewer's leniency taken out (fidelity 0.9510, verbosity 1.13).",
  },
  {
    id: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    ecosystem: "anthropic",
    status: "active",
    isPro: false,
    price: { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, batchInputPerMTok: 2, batchOutputPerMTok: 10 },
    context: { window: 1_000_000, maxOutput: 128_000, stdThreshold: null, surcharge: null }, // flat across 1M
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true }, // inherits 1M house values
    summarizer: { fidelityScore: 0.9596, verbosityCoeff: 1.11, provisionalFidelity: 0.92, calibrated: true, calibrationDate: "2026-10-12", confidence: 0.98, effort: "high" },
    sources: [
      VENDOR("Anthropic Claude Opus 5.5 model page", "https://platform.claude.com/docs/en/models/opus-5-5/overview", "2026-10"),
      VENDOR("Anthropic pricing docs", "https://platform.claude.com/docs/en/about-claude/pricing", "2026-10"),
    ],
    notes: "Released 2026-09-22. Flat pricing across the full 1M; cache reads 0.05x base input. Default effort 'medium' " +
      "(Opus 5 and earlier: 'high'); adaptive thinking is always on. " +
      "Calibrated 2026-10-12 (ADR-0012): golden-set mean of two pooled runs at effort 'high', all reviewers, " +
      "each reviewer's leniency taken out (fidelity 0.9596, verbosity 1.11).",
  },
  {
    id: "claude-sonnet-5-5",
    displayName: "Claude Sonnet 5.5",
    ecosystem: "anthropic",
    status: "active",
    isPro: false,
    price: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1, batchInputPerMTok: 1, batchOutputPerMTok: 5 },
    context: { window: 1_000_000, maxOutput: 128_000, stdThreshold: null, surcharge: null }, // flat across 1M
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true }, // inherits 1M house values
    summarizer: { fidelityScore: 0.9363, verbosityCoeff: 1.10, provisionalFidelity: 0.85, calibrated: true, calibrationDate: "2026-10-12", confidence: 0.98, effort: "high" },
    sources: [
      VENDOR("Anthropic Claude Sonnet 5.5 model page", "https://platform.claude.com/docs/en/models/sonnet-5-5/overview", "2026-10"),
      VENDOR("Anthropic pricing docs", "https://platform.claude.com/docs/en/about-claude/pricing", "2026-10"),
    ],
    notes: "Flat pricing across the full 1M; cache reads 0.05x base input. Default effort 'high' on the API but 'medium' " +
      "in Claude Code. Calibrated 2026-10-12 (ADR-0012): golden-set mean of two pooled runs at effort 'high', " +
      "all reviewers, each reviewer's leniency taken out (fidelity 0.9363, verbosity 1.10).",
  },
  {
    id: "claude-haiku-5-5",
    displayName: "Claude Haiku 5.5",
    ecosystem: "anthropic",
    status: "active",
    isPro: false,
    price: { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, batchInputPerMTok: 0.05, batchOutputPerMTok: 0.25 },
    // Prompts over 100,000 tokens: the whole request at 5x ($0.50/$2.50, Batch $0.25/$1.25, cache reads $0.05).
    context: { window: 1_000_000, maxOutput: 128_000, stdThreshold: 100_000, surcharge: { inputMult: 5, outputMult: 5 } },
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true }, // inherits 1M house values
    summarizer: { fidelityScore: 0.9366, verbosityCoeff: 1.15, provisionalFidelity: 0.70, calibrated: true, calibrationDate: "2026-10-12", confidence: 0.98, effort: "high" },
    sources: [
      VENDOR("Anthropic Claude Haiku 5.5 model page", "https://platform.claude.com/docs/en/models/haiku-5-5/overview", "2026-10"),
      VENDOR("Anthropic pricing docs", "https://platform.claude.com/docs/en/about-claude/pricing", "2026-10"),
    ],
    notes: "The only current Claude model with a long-context tier: a request over 100,000 prompt tokens (cache reads and " +
      "writes included) pays 5x on input, output and cache, Batch too. Default effort 'medium'. " +
      "Calibrated 2026-10-12 (ADR-0012): golden-set mean of two pooled runs at effort 'high', all reviewers, " +
      "each reviewer's leniency taken out (fidelity 0.9366, verbosity 1.15).",
  },

  // ---- Anthropic: suspended earlier generation ----
  {
    id: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    ecosystem: "anthropic",
    status: "suspended",
    isPro: false,
    price: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, batchInputPerMTok: 2.5, batchOutputPerMTok: 12.5 },
    context: { window: 1_000_000, maxOutput: 128_000, stdThreshold: null, surcharge: null }, // flat across 1M
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true },
    summarizer: { fidelityScore: 0.966, verbosityCoeff: 0.96, provisionalFidelity: 0.92, calibrated: true, calibrationDate: "2026-06-22", confidence: 0.98, effort: "max" },
    sources: [VENDOR("Anthropic pricing docs", "https://platform.claude.com/docs/en/about-claude/pricing", "2026-06")],
    notes: "Flat pricing across full 1M (no >200k surcharge, unlike 4.6/4.7). Effort defaults to 'high'. " + SUSPENDED_2026_10,
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    ecosystem: "anthropic",
    status: "suspended",
    isPro: false,
    price: { inputPerMTok: 3, outputPerMTok: 15, batchInputPerMTok: 1.5, batchOutputPerMTok: 7.5 },
    context: { window: 1_000_000, maxOutput: 128_000, stdThreshold: null, surcharge: null },
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true }, // inherits 1M house values
    summarizer: { fidelityScore: 0.974, verbosityCoeff: 0.97, provisionalFidelity: 0.85, calibrated: true, calibrationDate: "2026-06-22", confidence: 0.98, effort: "high" },
    sources: [VENDOR("Anthropic pricing docs", "https://platform.claude.com/docs/en/about-claude/pricing", "2026-06")],
    notes: SUSPENDED_2026_10,
  },
  {
    id: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    ecosystem: "anthropic",
    status: "suspended",
    isPro: false,
    price: { inputPerMTok: 1, outputPerMTok: 5, batchInputPerMTok: 0.5, batchOutputPerMTok: 2.5 },
    context: { window: 200_000, maxOutput: 64_000, stdThreshold: null, surcharge: null },
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true }, // same % inherited to 200k window
    summarizer: { fidelityScore: 0.980, verbosityCoeff: 0.78, provisionalFidelity: 0.70, calibrated: true, calibrationDate: "2026-06-22", confidence: 0.98, effort: "xhigh" },
    sources: [VENDOR("Anthropic pricing docs", "https://platform.claude.com/docs/en/about-claude/pricing", "2026-06")],
    notes: "Cheapest, but small-model + complex 7-bucket prompt is the risk case — must clear floor before use as default. " +
      "Anthropic: retirement not sooner than 2026-10-15. " + SUSPENDED_2026_10,
  },
  {
    id: "claude-fable-5",
    displayName: "Claude Fable 5",
    ecosystem: "anthropic",
    status: "suspended", // Anthropic lists it as legacy (still available); suspended here, superseded by Fable 5.1
    isPro: false,
    price: { inputPerMTok: 10, outputPerMTok: 50 },
    context: { window: 1_000_000, maxOutput: 128_000, stdThreshold: null, surcharge: null },
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true },
    summarizer: { fidelityScore: null, verbosityCoeff: 1.0, provisionalFidelity: 0.93, calibrated: false },
    sources: [VENDOR("Anthropic pricing review", "https://www.anthropic.com/news/fable-mythos-access", "2026-06")],
    notes: "Anthropic lists it as a legacy model (still available; retirement not sooner than 2027-06-09). Superseded by " +
      "Fable 5.1 and kept suspended (ADR-0012): never selected, calibrated or used as reviewer.",
  },

  // ---- OpenAI: summarizer pool (ADR-0012) ----
  // Above 272K input tokens the whole request costs 2x input (and cache) and 1.5x output - Batch included.
  {
    id: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    ecosystem: "openai",
    status: "active",
    isPro: false,
    price: { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 1, batchInputPerMTok: 5, batchOutputPerMTok: 25 },
    context: { window: 1_050_000, maxOutput: 128_000, stdThreshold: 272_000, surcharge: { inputMult: 2, outputMult: 1.5 } },
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true },
    summarizer: { fidelityScore: 0.9639, verbosityCoeff: 0.90, provisionalFidelity: 0.93, calibrated: true, calibrationDate: "2026-10-12", confidence: 0.98, effort: "high" },
    sources: [
      VENDOR("OpenAI GPT-6 Astra model docs", "https://developers.openai.com/api/docs/models/gpt-6-astra", "2026-10"),
      VENDOR("OpenAI API pricing (Batch)", "https://developers.openai.com/api/docs/pricing", "2026-10"),
    ],
    notes: "Max input 922,000 of the 1,050,000 window. Reasoning effort low..max; the default is not documented, so Cairn " +
      "always sets it. Codex: off by default on Enterprise/Edu. " +
      "Calibrated 2026-10-12 (ADR-0012): golden-set mean of two pooled runs at effort 'high', all reviewers, " +
      "each reviewer's leniency taken out (fidelity 0.9639, verbosity 0.90).",
  },
  {
    id: "gpt-6.1-sol",
    displayName: "GPT-6.1 Sol",
    ecosystem: "openai",
    status: "active",
    isPro: false,
    price: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1, batchInputPerMTok: 1, batchOutputPerMTok: 5 },
    context: { window: 1_050_000, maxOutput: 128_000, stdThreshold: 272_000, surcharge: { inputMult: 2, outputMult: 1.5 } },
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true },
    summarizer: { fidelityScore: 0.9573, verbosityCoeff: 0.88, provisionalFidelity: 0.92, calibrated: true, calibrationDate: "2026-10-12", confidence: 0.98, effort: "high" },
    sources: [
      VENDOR("OpenAI GPT-6.1 Sol model docs", "https://developers.openai.com/api/docs/models/gpt-6.1-sol", "2026-10"),
      VENDOR("OpenAI API pricing (Batch)", "https://developers.openai.com/api/docs/pricing", "2026-10"),
    ],
    notes: "Max input 922,000 of the 1,050,000 window; cache reads 0.05x base input. Reasoning effort low..max, default " +
      "'medium'. Codex's recommended model (`codex exec -m gpt-6.1-sol`). " +
      "Calibrated 2026-10-12 (ADR-0012): golden-set mean of two pooled runs at effort 'high', all reviewers, " +
      "each reviewer's leniency taken out (fidelity 0.9573, verbosity 0.88).",
  },
  {
    id: "gpt-6-luna",
    displayName: "GPT-6 Luna",
    ecosystem: "openai",
    status: "active",
    isPro: false,
    price: { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, batchInputPerMTok: 0.05, batchOutputPerMTok: 0.25 },
    context: { window: 1_050_000, maxOutput: 128_000, stdThreshold: 272_000, surcharge: { inputMult: 2, outputMult: 1.5 } },
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true },
    summarizer: { fidelityScore: 0.9397, verbosityCoeff: 0.76, provisionalFidelity: 0.70, calibrated: true, calibrationDate: "2026-10-12", confidence: 0.98, effort: "high" },
    sources: [
      VENDOR("OpenAI GPT-6 Luna model docs", "https://developers.openai.com/api/docs/models/gpt-6-luna", "2026-10"),
      VENDOR("OpenAI API pricing (Batch)", "https://developers.openai.com/api/docs/pricing", "2026-10"),
    ],
    notes: "Max input 922,000 of the 1,050,000 window. Reasoning effort none, low..max, default 'medium'. " +
      "Calibrated 2026-10-12 (ADR-0012): golden-set mean of two pooled runs at effort 'high', all reviewers, " +
      "each reviewer's leniency taken out (fidelity 0.9397, verbosity 0.76).",
  },

  // ---- OpenAI: suspended earlier generation ----
  {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    ecosystem: "openai",
    status: "suspended",
    isPro: false,
    price: { inputPerMTok: 5, outputPerMTok: 30, cacheReadPerMTok: 0.5, batchInputPerMTok: 2.5, batchOutputPerMTok: 15 },
    context: { window: 1_050_000, maxOutput: 128_000, stdThreshold: 272_000, surcharge: { inputMult: 2, outputMult: 1.5 } },
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true },
    summarizer: { fidelityScore: 0.971, verbosityCoeff: 1.1, provisionalFidelity: 0.90, calibrated: true, calibrationDate: "2026-06-22", confidence: 0.98, effort: "xhigh" },
    sources: [
      VENDOR("OpenAI model docs", "https://developers.openai.com/api/docs/models/gpt-5.5", "2026-06"),
      VENDOR("OpenAI model docs (1,050,000 context window)", "https://developers.openai.com/api/docs/models/gpt-5.5", "2026-10"),
    ],
    notes: "Reasoning effort (none/low/medium/high/xhigh) does NOT change per-token price — token-volume lever only. Codex surface windows are plan/client dependent; current rollout telemetry observed 258400, so pass the host-reported surfaceCap. GPT-5.5 leaves ChatGPT/Codex on 2026-10-14 (the OpenAI API keeps it). " + SUSPENDED_2026_10,
  },
  {
    id: "gpt-5.5-pro",
    displayName: "GPT-5.5 Pro",
    ecosystem: "openai",
    status: "suspended",
    isPro: true,
    price: { inputPerMTok: 30, outputPerMTok: 180 },
    context: { window: 1_050_000, maxOutput: 128_000, stdThreshold: 272_000, surcharge: { inputMult: 2, outputMult: 1.5 } },
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true },
    summarizer: { fidelityScore: null, verbosityCoeff: 1.0, provisionalFidelity: 0.91, calibrated: false },
    sources: [
      VENDOR("OpenAI / model-drop reporting", "https://developers.openai.com/api/docs/models/gpt-5.5", "2026-06"),
      VENDOR("OpenAI model docs (1,050,000 context window)", "https://developers.openai.com/api/docs/models/gpt-5.5-pro", "2026-10"),
    ],
    notes: "Separate model id, 6x the standard rate. Covers consumer 'pro standard'/'pro erweitert'. Tiebreaker should avoid unless fidelity gap is real. " + SUSPENDED_2026_10,
  },
  {
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    ecosystem: "openai",
    status: "suspended",
    isPro: false,
    price: { inputPerMTok: 2.5, outputPerMTok: 15, batchInputPerMTok: 1.25, batchOutputPerMTok: 7.5 },
    context: { window: 1_050_000, maxOutput: 128_000, stdThreshold: 272_000, surcharge: { inputMult: 2, outputMult: 1 } },
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true },
    summarizer: { fidelityScore: 0.973, verbosityCoeff: 1.16, provisionalFidelity: 0.82, calibrated: true, calibrationDate: "2026-06-22", confidence: 0.98, effort: "high" },
    sources: [VENDOR("GPT-5.4 API guide", "https://www.nxcode.io/resources/news/gpt-5-4-api-developer-guide-reasoning-computer-use-2026", "2026-03")],
    notes: "Output surcharge multiplier above 272k not clearly documented; set to 1 (input doubles). Verify before relying on long-ctx output cost. Effort 'high': the 5-probe golden set (2026-06-22) showed high ≥ xhigh (0.989 vs 0.984, within the ADR-0002 band) AND high is cheaper — strictly dominant. fidelityScore kept on the single-probe calibration basis for cross-profile comparability. " + SUSPENDED_2026_10,
  },
  {
    id: "gpt-5.4-pro",
    displayName: "GPT-5.4 Pro",
    ecosystem: "openai",
    status: "suspended",
    isPro: true,
    price: { inputPerMTok: 30, outputPerMTok: 180 },
    context: { window: 1_050_000, maxOutput: 128_000, stdThreshold: 272_000, surcharge: { inputMult: 2, outputMult: 1 } },
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true },
    summarizer: { fidelityScore: null, verbosityCoeff: 1.0, provisionalFidelity: 0.83, calibrated: false },
    sources: [VENDOR("GPT-5.4 API guide", "https://www.nxcode.io/resources/news/gpt-5-4-api-developer-guide-reasoning-computer-use-2026", "2026-03")],
    notes: SUSPENDED_2026_10,
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

/** The summarizer pool (ADR-0012): the active Anthropic/OpenAI full profiles, i.e. the current generation.
 *  Suspended profiles and the context-only entries are never part of it. */
export function summarizerPool(profiles: ModelProfile[] = PROFILES): ModelProfile[] {
  return profiles.filter((p) => p.status === "active" && (p.ecosystem === "anthropic" || p.ecosystem === "openai"));
}

/* ------------------------------------------------------------------ */
/* Context-only entries - current vendor models without a full profile */
/* ------------------------------------------------------------------ */

/**
 * Current vendor models (official model overviews, October 2026) outside the summarizer pool. Only
 * the context window and max output are sourced; pricing (incl. long-context surcharges) and summarizer
 * fidelity are not profiled - their price/threshold fields are placeholders - and the zones are the
 * shared provisional house values. These entries are NEVER summarizer or calibration
 * candidates - selection and calibration read PROFILES only. They exist so `resolveProfile` gives the
 * statusline/context_status the right window instead of the 128k generic fallback. Promote an entry
 * to PROFILES (with sourced pricing) when its model gets full support. Since ADR-0012 the six pool
 * models are full profiles; only gpt-6-sol remains here.
 */
interface ContextOnlyModel {
  id: string;
  displayName: string;
  ecosystem: "anthropic" | "openai";
  window: number;
  maxOutput: number;
  url: string;
}

const CONTEXT_ONLY_MODELS: ContextOnlyModel[] = [
  // gpt-6-sol: Codex's replacement for the retiring gpt-5.5 on Plus/Pro/Business/Enterprise/Edu plans, not in
  // the summarizer pool (its successor GPT-6.1 Sol is). 1,050,000 context window (max input 922,000), 128,000 max output.
  { id: "gpt-6-sol", displayName: "GPT-6 Sol", ecosystem: "openai", window: 1_050_000, maxOutput: 128_000, url: "https://developers.openai.com/api/docs/models/gpt-6-sol" },
];

export const CONTEXT_ONLY_PROFILES: ModelProfile[] = CONTEXT_ONLY_MODELS.map((m) =>
  ModelProfile.parse({
    ...GENERIC_FALLBACK,
    id: m.id,
    displayName: m.displayName,
    ecosystem: m.ecosystem,
    context: { window: m.window, maxOutput: m.maxOutput, stdThreshold: null, surcharge: null },
    qualityZone: { greenPct: 0.40, yellowPct: 0.70, provisional: true }, // same house values as the vendor profiles
    sources: [VENDOR(`${m.displayName} model docs`, m.url, "2026-10")],
    notes: "Context-only entry: window and max output are sourced; pricing and summarizer fidelity are not profiled.",
  }),
);

/**
 * Normalise a host-reported model id: strip real-world decorations that break exact matching -
 * a trailing `[1m]`/`(…)` (Claude Code's 1M-context suffix), an `@effort` variant, and a
 * provider/region prefix like `us.anthropic.` / `global.anthropic.` / `us-gov.anthropic.` / `openai/`
 * (Bedrock/Vertex). Lower-cased.
 */
export function normalizeModelId(id: string): string {
  let s = id.trim().toLowerCase();
  s = s.replace(/[[(][^\])]*[\])]\s*$/, ""); // trailing "[1m]" / "(…)"
  s = s.replace(/@[^@]*$/, ""); // trailing "@effort"
  s = s.replace(/^(?:(?:[a-z]{2,4}|global|us-gov)\.)?(?:anthropic|openai|google|meta|bedrock|vertex)[./]/, ""); // provider/region prefix
  return s.trim();
}

/** What may follow a model id and still name the same model: a snapshot date and/or a provider version
 *  (`-v1:0`). A version step (`claude-opus-5` → `claude-opus-5-5`) is a different model. */
const SAME_MODEL_SUFFIX = /^(?:-(?:\d{8}|\d{4}-\d{2}-\d{2}))?(?:-v\d+(?::\d+)?)?$/;

/** True if a reported model id names the requested one (`requested` normalized, see `normalizeModelId`). */
export function isSameModel(reported: string, requested: string): boolean {
  const n = normalizeModelId(reported);
  return n.startsWith(requested) && SAME_MODEL_SUFFIX.test(n.slice(requested.length));
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

/** A vendor snapshot date suffix: Anthropic `20251001` or ISO `2026-04-23`. A bare version digit
 *  is NOT one, so `claude-opus-5` (Opus 5) never collapses into `claude-opus-5-5` (Opus 5.5). */
const DATE_SUFFIX = /^(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * Resolve a host-reported model id to a profile, tolerant of id decorations exact matching misses -
 * so the statusline/context_status don't silently fall back to `generic:unknown` (wrong window +
 * zones). Handles `claude-opus-4-8[1m]`, Codex slugs like `gpt-5.5-codex`/dated suffixes,
 * Bedrock/Vertex prefixes, date-suffixed profile ids the host omits (`claude-haiku-4-5` →
 * `claude-haiku-4-5-20251001`), and deprecated-model aliases. Strategy: exact → normalised-exact →
 * longest separator-bounded profile-prefix → date-suffix reverse match → alias → GENERIC_FALLBACK.
 * The context-only entries take part in every step; a full profile with the same id wins.
 */
export function resolveProfile(id: string | undefined, profiles: ModelProfile[] = PROFILES): ModelProfile {
  if (!id) return GENERIC_FALLBACK;
  // One pool, so the longest id wins across both sets (claude-fable-5-1 beats the claude-fable-5 prefix).
  const pool = [...profiles, ...CONTEXT_ONLY_PROFILES.filter((c) => !profiles.some((p) => p.id === c.id))];
  const exact = pool.find((p) => p.id === id);
  if (exact) return exact;
  const norm = normalizeModelId(id);
  if (!norm) return GENERIC_FALLBACK;
  const normExact = pool.find((p) => p.id.toLowerCase() === norm);
  if (normExact) return normExact;
  // forward: profile id is a separator-bounded prefix of the model id (gpt-5.5-codex → gpt-5.5)
  const byPrefix = pool
    .filter((p) => norm.startsWith(p.id.toLowerCase()) && isBoundary(norm.charAt(p.id.length)))
    .sort((a, b) => b.id.length - a.id.length)[0];
  if (byPrefix) return byPrefix;
  // reverse: profile carries a DATE suffix the host omits (date only, so `-pro`/`-codex`/`-5` never collapse)
  const byDate = pool.find((p) => {
    const pid = p.id.toLowerCase();
    return pid.startsWith(norm + "-") && DATE_SUFFIX.test(pid.slice(norm.length + 1));
  });
  if (byDate) return byDate;
  // alias: deprecated id → migration target (separator-bounded prefix, e.g. gpt-5.3-codex → gpt-5.4)
  const aliasKey = Object.keys(PROFILE_ALIASES)
    .filter((k) => norm.startsWith(k) && isBoundary(norm.charAt(k.length)))
    .sort((a, b) => b.length - a.length)[0];
  if (aliasKey) {
    const target = pool.find((p) => p.id === PROFILE_ALIASES[aliasKey]);
    if (target) return target;
  }
  return GENERIC_FALLBACK;
}

/**
 * Fidelity floor (ADR-0004/0005/0012): below this a model must NOT compact → verbatim fallback.
 * Set from the 2026-10-12 golden-set calibration (two runs pooled, all reviewers, each reviewer's
 * leniency taken out): the pool measured 0.936–0.964, the picks Claude Opus 5.5 0.9596 and GPT-6.1
 * Sol 0.9573. At 0.84 both clear even the red-zone +0.10 escalation (0.94), by 0.020 and 0.017, so a full
 * context is still compacted rather than handed over verbatim, while the local/generic fallbacks
 * (≤0.60) stay below it. Signed off by the user on 2026-10-12. Not the golden `floorProposal` (median
 * of the means, about 0.95): with the zone bumps it would send every yellow and red handoff to verbatim.
 */
export const FIDELITY_FLOOR = 0.84;

/* ------------------------------------------------------------------ */
/* Context zones (ADR-0003)                                            */
/* ------------------------------------------------------------------ */

/** A usable window value: finite and positive (a missing, zero or overflowing host field is ignored). */
function usableWindow(n: number | null | undefined): number | undefined {
  return n != null && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Effective working window = the smallest of model max, surface cap, and any user override. For an
 *  unknown model the generic 128k is a placeholder, not a model max, so an explicit window wins. */
export function activeWindow(p: ModelProfile, opts: { surfaceCap?: number; userOverride?: number } = {}): number {
  const surfaceCap = usableWindow(opts.surfaceCap);
  const userOverride = usableWindow(opts.userOverride);
  const explicit = surfaceCap != null || userOverride != null;
  const modelMax = p.id === GENERIC_FALLBACK.id && explicit ? Infinity : p.context.window;
  return Math.min(modelMax, surfaceCap ?? Infinity, userOverride ?? Infinity);
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
  const id = normalizeModelId(h.modelId ?? ""); // so Bedrock ids like `anthropic.claude-opus-5-5` count as Claude
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
  const topBand = pool
    .filter((p) => maxF - fidelityKey(p) <= FIDELITY_BAND)
    .sort((a, b) => effectiveCost(a, input.cost) - effectiveCost(b, input.cost));

  // Stage 4: fidelity floor - zone escalation RAISES the floor (harder source context demands a
  // stronger summarizer). The cheapest band model that clears the effective floor is selected; a cheaper
  // one below it gives way to the next band model instead of a verbatim fallback (ADR-0012). Verbatim
  // only when no band model clears it - then no reachable model does, since the band holds the best one.
  const ESCALATION_BUMP: Record<Zone, number> = { green: 0, yellow: 0.05, red: 0.10 };
  const effectiveFloor = input.fidelityFloor + ESCALATION_BUMP[input.sourceZone];
  const chosen = topBand.find((p) => fidelityKey(p) >= effectiveFloor);
  if (!chosen) {
    const best = topBand.reduce((a, b) => (fidelityKey(b) > fidelityKey(a) ? b : a));
    return {
      kind: "verbatim-fallback",
      reason: `best available '${best.id}' (fidelity ${fidelityKey(best).toFixed(3)}) below ` +
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
