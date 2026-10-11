import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  PROFILES,
  CONTEXT_ONLY_PROFILES,
  GENERIC_FALLBACK,
  ModelProfile,
  activeWindow,
  zoneBoundaries,
  classifyZone,
  resolveProfile,
  normalizeModelId,
  effectiveCost,
  detectEcosystem,
  selectSummarizer,
  type CostInput,
} from "./model-profiles";

/** Helper to fetch a seed profile by id (all asserted to exist). */
function profile(id: string): ModelProfile {
  const p = PROFILES.find((x) => x.id === id);
  if (!p) throw new Error(`seed profile '${id}' missing`);
  return p;
}

const opus = profile("claude-opus-4-8");
const gpt55 = profile("gpt-5.5");

/** Provisional view of the seed (calibration reset). The selector/cost LOGIC tests run against
 *  this so they stay stable regardless of the live-calibrated values now baked into PROFILES;
 *  the calibrated selection is asserted separately below. */
const PROVISIONAL = PROFILES.map((p) => ({
  ...p,
  summarizer: { ...p.summarizer, fidelityScore: null, calibrated: false, verbosityCoeff: 1.0 },
}));
const opusP = PROVISIONAL.find((p) => p.id === "claude-opus-4-8")!;
const gpt55P = PROVISIONAL.find((p) => p.id === "gpt-5.5")!;

describe("resolveProfile (tolerant model-id matching, ADR-0003)", () => {
  it("matches Claude Code's 1M-context suffix `[1m]`", () => {
    expect(resolveProfile("claude-opus-4-8[1m]").id).toBe("claude-opus-4-8");
  });
  it("matches Codex `-codex` and dated suffixes to the base profile", () => {
    expect(resolveProfile("gpt-5.5-codex").id).toBe("gpt-5.5");
    expect(resolveProfile("gpt-5.5-2025-10-01").id).toBe("gpt-5.5");
  });
  it("keeps distinct variants distinct (does not collapse -pro into base)", () => {
    expect(resolveProfile("gpt-5.5-pro").id).toBe("gpt-5.5-pro");
  });
  it("strips Bedrock/Vertex provider prefixes", () => {
    expect(resolveProfile("us.anthropic.claude-opus-4-8").id).toBe("claude-opus-4-8");
    expect(resolveProfile("openai/gpt-5.5").id).toBe("gpt-5.5");
  });
  it("requires a separator boundary for prefix matches", () => {
    expect(resolveProfile("gpt-5.55").id).toBe("generic:unknown");
  });
  it("matches a date-suffixed profile id the host omits (claude-haiku-4-5 → dated profile)", () => {
    expect(resolveProfile("claude-haiku-4-5").id).toBe("claude-haiku-4-5-20251001");
  });
  it("aliases deprecated ids to their migration target (gpt-5.3-codex → gpt-5.4)", () => {
    expect(resolveProfile("gpt-5.3-codex").id).toBe("gpt-5.4");
    expect(resolveProfile("gpt-5.3").id).toBe("gpt-5.4");
  });
  it("falls back to generic for unknown / empty ids", () => {
    expect(resolveProfile("totally-unknown").id).toBe("generic:unknown");
    expect(resolveProfile(undefined).id).toBe("generic:unknown");
  });
  it("normalizeModelId lower-cases and strips decorations", () => {
    expect(normalizeModelId("Claude-Opus-4-8[1m]")).toBe("claude-opus-4-8");
  });
});

/* ------------------------------------------------------------------ */
/* Claude Opus 5.5 + the other current vendor models (2026-10)        */
/* ------------------------------------------------------------------ */

const opus55 = profile("claude-opus-5-5");

describe("Claude Opus 5.5 profile (sourced 2026-10)", () => {
  it("carries the documented window, max output and prices; flat across 1M", () => {
    expect(opus55.displayName).toBe("Claude Opus 5.5");
    expect(opus55.ecosystem).toBe("anthropic");
    expect(opus55.status).toBe("active");
    expect(opus55.context).toEqual({ window: 1_000_000, maxOutput: 128_000, stdThreshold: null, surcharge: null });
    expect(opus55.price).toEqual({
      inputPerMTok: 4,
      outputPerMTok: 20,
      cacheReadPerMTok: 0.2,
      batchInputPerMTok: 2,
      batchOutputPerMTok: 10,
    });
  });

  it("is uncalibrated: provisional fidelity only, no measured score", () => {
    expect(opus55.summarizer.calibrated).toBe(false);
    expect(opus55.summarizer.fidelityScore).toBeNull();
    expect(opus55.summarizer.provisionalFidelity).toBe(0.92);
  });

  it("costs $4/$20 per MTok with no long-context surcharge (batch: half)", () => {
    const opus55P = PROVISIONAL.find((p) => p.id === "claude-opus-5-5")!;
    // 0.18M*$4 + 0.006M*$20 = 0.72 + 0.12 = 0.84 ; batch 0.18M*$2 + 0.006M*$10 = 0.36 + 0.06 = 0.42
    expect(effectiveCost(opus55P, { inputTokens: 180_000, expectedBriefTokens: 6_000 })).toBeCloseTo(0.84, 6);
    expect(effectiveCost(opus55P, { inputTokens: 180_000, expectedBriefTokens: 6_000, useBatch: true })).toBeCloseTo(0.42, 6);
    // 900k input is billed at the same rate: 0.9M*$4 + 0.006M*$20 = 3.6 + 0.12 = 3.72
    expect(effectiveCost(opus55P, { inputTokens: 900_000, expectedBriefTokens: 6_000 })).toBeCloseTo(3.72, 6);
  });

  it("zones sit at 40/70 % of its 1M window", () => {
    expect(zoneBoundaries(opus55, activeWindow(opus55))).toEqual({
      window: 1_000_000,
      greenUntil: 400_000,
      yellowUntil: 700_000,
      redUntil: 1_000_000,
    });
  });

  it("is detected as Anthropic", () => {
    expect(detectEcosystem({ modelId: "claude-opus-5-5" })).toBe("anthropic");
  });
});

describe("resolveProfile — Claude Opus 5.5 ids", () => {
  it.each([
    "claude-opus-5-5",
    "claude-opus-5-5[1m]",
    "Claude-Opus-5-5",
    "claude-opus-5-5@medium",
    "anthropic.claude-opus-5-5", // Amazon Bedrock
    "us.anthropic.claude-opus-5-5", // Bedrock regional inference profile
  ])("%s → claude-opus-5-5", (id) => {
    expect(resolveProfile(id).id).toBe("claude-opus-5-5");
  });

  it("a bare version step is not a date suffix: Opus 5 / Sonnet 5 don't collapse into the 5.5 entries", () => {
    expect(resolveProfile("claude-opus-5").id).not.toBe("claude-opus-5-5");
    expect(resolveProfile("claude-sonnet-5").id).not.toBe("claude-sonnet-5-5");
    // a real snapshot date still resolves (Anthropic yyyymmdd)
    expect(resolveProfile("claude-haiku-4-5").id).toBe("claude-haiku-4-5-20251001");
  });

  it("keeps Opus 4.8 distinct from Opus 5.5", () => {
    expect(resolveProfile("claude-opus-4-8").id).toBe("claude-opus-4-8");
    expect(resolveProfile("claude-opus-4-8[1m]").id).toBe("claude-opus-4-8");
  });
});

describe("resolveProfile — every current Anthropic and OpenAI model gets its documented window", () => {
  // Anthropic models overview (current lineup) and OpenAI models overview (flagship/featured models) plus
  // gpt-6-sol, Codex's replacement for gpt-5.5.
  it.each([
    ["claude-fable-5-1", 1_000_000],
    ["claude-opus-5-5", 1_000_000],
    ["claude-sonnet-5-5", 1_000_000],
    ["claude-haiku-5-5", 1_000_000],
    ["gpt-6-astra", 1_050_000],
    ["gpt-6.1-sol", 1_050_000],
    ["gpt-6-luna", 1_050_000],
    ["gpt-6-sol", 1_050_000],
  ])("%s → own entry, window %i, max output 128k", (id, window) => {
    const p = resolveProfile(id);
    expect(p.id).toBe(id);
    expect(p.context.window).toBe(window);
    expect(p.context.maxOutput).toBe(128_000);
    expect(activeWindow(p)).toBe(window);
  });

  it("uses the vendor-profile zone fractions, not the conservative generic ones", () => {
    for (const p of CONTEXT_ONLY_PROFILES) expect(p.qualityZone).toEqual({ greenPct: 0.4, yellowPct: 0.7, provisional: true });
  });

  it("tolerates host decorations on the new ids", () => {
    expect(resolveProfile("anthropic.claude-sonnet-5-5").id).toBe("claude-sonnet-5-5");
    expect(resolveProfile("claude-haiku-5-5[1m]").id).toBe("claude-haiku-5-5");
    expect(resolveProfile("openai/gpt-6.1-sol").id).toBe("gpt-6.1-sol");
    expect(resolveProfile("gpt-6-luna@high").id).toBe("gpt-6-luna");
  });

  it("the longest id wins across profiles and context-only entries (Fable 5.1 ≠ Fable 5)", () => {
    expect(resolveProfile("claude-fable-5-1").id).toBe("claude-fable-5-1");
    expect(resolveProfile("claude-fable-5").id).toBe("claude-fable-5");
  });

  it("a full profile with the same id shadows the context-only entry", () => {
    const full: ModelProfile = { ...gpt55, id: "gpt-6-astra", displayName: "GPT-6 Astra (full)" };
    expect(resolveProfile("gpt-6-astra", [...PROFILES, full]).displayName).toBe("GPT-6 Astra (full)");
  });

  it("corrects the GPT-5.5 / GPT-5.5 Pro window to the documented 1,050,000", () => {
    expect(resolveProfile("gpt-5.5").context.window).toBe(1_050_000);
    expect(resolveProfile("gpt-5.5-pro").context.window).toBe(1_050_000);
  });

  it("context-only entries are never summarizer candidates (selection reads PROFILES only)", async () => {
    const ids = new Set(PROFILES.map((p) => p.id));
    for (const p of CONTEXT_ONLY_PROFILES) expect(ids.has(p.id)).toBe(false);
    const r = await selectSummarizer({
      host: { modelId: "gpt-6-astra" },
      sourceZone: "green",
      cost: { inputTokens: 180_000, expectedBriefTokens: 6_000 },
      fidelityFloor: 0,
    });
    expect(r.kind).toBe("model");
    if (r.kind !== "model") throw new Error("expected a model pick");
    expect(ids.has(r.model.id)).toBe(true);
    expect(r.model.ecosystem).toBe("openai");
  });
});

/* ------------------------------------------------------------------ */
/* activeWindow (ADR-0003: min of model max, surface cap, override)    */
/* ------------------------------------------------------------------ */

describe("activeWindow", () => {
  it("returns the native model window when nothing caps it", () => {
    expect(activeWindow(opus)).toBe(1_000_000);
  });

  it("is capped by the surface (Foundry 200k, observed Codex 258400)", () => {
    expect(activeWindow(opus, { surfaceCap: 200_000 })).toBe(200_000);
    expect(activeWindow(gpt55, { surfaceCap: 258_400 })).toBe(258_400);
  });

  it("takes the smallest of model max, surface cap and user override", () => {
    expect(activeWindow(opus, { userOverride: 150_000 })).toBe(150_000);
    expect(activeWindow(opus, { surfaceCap: 200_000, userOverride: 150_000 })).toBe(150_000);
  });
});

/* ------------------------------------------------------------------ */
/* zoneBoundaries (% of the ACTIVE window, not model max)              */
/* ------------------------------------------------------------------ */

describe("zoneBoundaries", () => {
  it("Opus @1M -> green<=400k, yellow<=700k, red=1M", () => {
    const b = zoneBoundaries(opus, activeWindow(opus));
    expect(b).toEqual({ window: 1_000_000, greenUntil: 400_000, yellowUntil: 700_000, redUntil: 1_000_000 });
  });

  it("surface-relative: Opus @200k cap -> green<=80k, yellow<=140k (ADR-0003)", () => {
    const b = zoneBoundaries(opus, activeWindow(opus, { surfaceCap: 200_000 }));
    expect(b.greenUntil).toBe(80_000);
    expect(b.yellowUntil).toBe(140_000);
    expect(b.redUntil).toBe(200_000);
  });

  it("noiseFactor tightens the boundaries for tool-/search-heavy sessions", () => {
    const b = zoneBoundaries(opus, activeWindow(opus), 0.5);
    expect(b.greenUntil).toBe(200_000); // 1M * 0.40 * 0.5
    expect(b.yellowUntil).toBe(350_000); // 1M * 0.70 * 0.5
  });
});

/* ------------------------------------------------------------------ */
/* classifyZone                                                        */
/* ------------------------------------------------------------------ */

describe("classifyZone", () => {
  const b = zoneBoundaries(opus, activeWindow(opus)); // green<=400k, yellow<=700k

  it("classifies tokens against the boundaries (inclusive lower edges)", () => {
    expect(classifyZone(0, b)).toBe("green");
    expect(classifyZone(400_000, b)).toBe("green");
    expect(classifyZone(400_001, b)).toBe("yellow");
    expect(classifyZone(700_000, b)).toBe("yellow");
    expect(classifyZone(700_001, b)).toBe("red");
    expect(classifyZone(1_000_000, b)).toBe("red");
  });
});

/* ------------------------------------------------------------------ */
/* effectiveCost (ADR-0002 tiebreaker)                                 */
/* ------------------------------------------------------------------ */

describe("effectiveCost", () => {
  const cost: CostInput = { inputTokens: 180_000, expectedBriefTokens: 6_000 };

  it("Opus is flat (no long-context surcharge); batch rates are cheaper", () => {
    // 0.18M*$5 + 0.006M*$25 = 0.90 + 0.15 = 1.05  (provisional verbosityCoeff 1.0)
    expect(effectiveCost(opusP, cost)).toBeCloseTo(1.05, 6);
    // batch: 0.18M*$2.5 + 0.006M*$12.5 = 0.45 + 0.075 = 0.525
    expect(effectiveCost(opusP, { ...cost, useBatch: true })).toBeCloseTo(0.525, 6);
  });

  it("GPT-5.5 doubles input rate above the 272k threshold (whole-session surcharge)", () => {
    const below: CostInput = { inputTokens: 200_000, expectedBriefTokens: 6_000 };
    const above: CostInput = { inputTokens: 300_000, expectedBriefTokens: 6_000 };
    // below: 0.2M*$5 + 0.006M*$30 = 1.0 + 0.18 = 1.18
    expect(effectiveCost(gpt55P, below)).toBeCloseTo(1.18, 6);
    // above: input x2 (=$10), output x1.5 (=$45): 0.3M*$10 + 0.006M*$45 = 3.0 + 0.27 = 3.27
    expect(effectiveCost(gpt55P, above)).toBeCloseTo(3.27, 6);
  });

  it("verbosityCoeff scales the emitted brief tokens (token-efficiency lever)", () => {
    const briefOnly: CostInput = { inputTokens: 0, expectedBriefTokens: 6_000 };
    const dense: ModelProfile = { ...opusP, summarizer: { ...opusP.summarizer, verbosityCoeff: 0.5 } };
    // opus vc=1.0: 0.006M*$25 = 0.15 ; dense vc=0.5: 0.003M*$25 = 0.075
    expect(effectiveCost(opusP, briefOnly)).toBeCloseTo(0.15, 6);
    expect(effectiveCost(dense, briefOnly)).toBeCloseTo(0.075, 6);
    expect(effectiveCost(dense, briefOnly)).toBeLessThan(effectiveCost(opusP, briefOnly));
  });
});

/* ------------------------------------------------------------------ */
/* detectEcosystem (ADR-0004 stage 0)                                  */
/* ------------------------------------------------------------------ */

describe("detectEcosystem", () => {
  it("maps host signals to the right ecosystem", () => {
    expect(detectEcosystem({ modelId: "claude-opus-4-8" })).toBe("anthropic");
    expect(detectEcosystem({ provider: "bedrock" })).toBe("anthropic");
    expect(detectEcosystem({ modelId: "gpt-5.5" })).toBe("openai");
    expect(detectEcosystem({ provider: "openai" })).toBe("openai");
    expect(detectEcosystem({ provider: "ollama" })).toBe("local");
    expect(detectEcosystem({ provider: "lmstudio" })).toBe("local");
    expect(detectEcosystem({ modelId: "some-unknown-model" })).toBe("generic");
  });
});

/* ------------------------------------------------------------------ */
/* selectSummarizer - the four demo cases (ADR-0002 + 0003 + 0004)     */
/* ------------------------------------------------------------------ */

describe("selectSummarizer", () => {
  const cost: CostInput = { inputTokens: 180_000, expectedBriefTokens: 6_000 };

  it("green-pick: Claude host in green zone picks a model (Opus; Fable is suspended)", async () => {
    const r = await selectSummarizer({
      host: { modelId: "claude-opus-4-8" },
      sourceZone: "green",
      cost,
      fidelityFloor: 0.0,
      profiles: PROVISIONAL,
    });
    expect(r.kind).toBe("model");
    if (r.kind !== "model") throw new Error("expected a model pick");
    // Opus 5.5 shares Opus 4.8's provisional prior (0.92) and is cheaper → ADR-0002 cost tiebreak.
    expect(r.model.id).toBe("claude-opus-5-5");
  });

  it("red-escalation picks the cheaper sibling (gpt-5.5), NOT the 6x Pro (ADR-0002)", async () => {
    const r = await selectSummarizer({
      host: { provider: "openai", modelId: "gpt-5.5" },
      sourceZone: "red", // escalate - but cost still decides within the equal-fidelity band
      cost,
      fidelityFloor: 0.0,
      profiles: PROVISIONAL,
    });
    expect(r.kind).toBe("model");
    if (r.kind !== "model") throw new Error("expected a model pick");
    expect(r.model.id).toBe("gpt-5.5");
    expect(r.model.id).not.toBe("gpt-5.5-pro");
  });

  it("ecosystem exclusion: a Claude user is never given an OpenAI model (ADR-0004)", async () => {
    const r = await selectSummarizer({
      host: { modelId: "claude-sonnet-4-6" },
      sourceZone: "green",
      cost,
      fidelityFloor: 0.0,
      profiles: PROVISIONAL,
    });
    expect(r.kind).toBe("model");
    if (r.kind !== "model") throw new Error("expected a model pick");
    expect(r.model.ecosystem).not.toBe("openai");
    expect(r.model.id.startsWith("gpt")).toBe(false);
  });

  it("verbatim-fallback: only a weak model reachable in RED can't clear the bumped floor (ADR-0004)", async () => {
    const r = await selectSummarizer({
      host: { modelId: "claude-haiku-4-5-20251001" },
      sourceZone: "red", // bumps floor 0.75 -> 0.85; Haiku's 0.70 can't clear it
      cost,
      fidelityFloor: 0.75,
      profiles: PROVISIONAL,
      reachable: async (p) => p.id === "claude-haiku-4-5-20251001",
    });
    expect(r.kind).toBe("verbatim-fallback");
  });
});

/* ------------------------------------------------------------------ */
/* Calibrated selection (2026-06-22 cross-ecosystem run)               */
/* ------------------------------------------------------------------ */

describe("selectSummarizer — calibrated seed (ADR-0002 cost tiebreak)", () => {
  const cost: CostInput = { inputTokens: 180_000, expectedBriefTokens: 6_000 };

  it("Anthropic green-pick now returns HAIKU: measured fidelity ties opus/sonnet within the band → cheapest wins", async () => {
    const r = await selectSummarizer({
      host: { modelId: "claude-opus-4-8" },
      sourceZone: "green",
      cost,
      fidelityFloor: 0.0,
    });
    expect(r.kind).toBe("model");
    if (r.kind !== "model") throw new Error("expected a model pick");
    expect(r.model.id).toBe("claude-haiku-4-5-20251001"); // calibrated 0.980, cheapest in the top band
  });

  it("a calibrated model clears the 0.85 floor even in the red zone (no needless verbatim fallback)", async () => {
    const r = await selectSummarizer({
      host: { modelId: "claude-haiku-4-5-20251001" },
      sourceZone: "red",
      cost,
      fidelityFloor: 0.85,
      reachable: async (p) => p.id === "claude-haiku-4-5-20251001",
    });
    expect(r.kind).toBe("model"); // haiku 0.980 ≥ 0.85+0.10
  });
});

/* ------------------------------------------------------------------ */
/* Promotion invariants (T0 acceptance)                                */
/* ------------------------------------------------------------------ */

describe("promotion invariants", () => {
  it("all seed profiles + the generic fallback validate against the schema", () => {
    expect(PROFILES.length).toBeGreaterThan(0);
    for (const p of PROFILES) expect(() => ModelProfile.parse(p)).not.toThrow();
    expect(() => ModelProfile.parse(GENERIC_FALLBACK)).not.toThrow();
  });

  it("has NO runtime side effect on import: the demo block is gone (no auto-demo())", () => {
    const src = readFileSync(fileURLToPath(new URL("./model-profiles.ts", import.meta.url)), "utf8");
    expect(/function\s+demo\b/.test(src)).toBe(false);
    expect(/^\s*demo\(\)/m.test(src)).toBe(false);
    expect(/console\.log/.test(src)).toBe(false);
    expect(/process\.exit/.test(src)).toBe(false);
  });
});
