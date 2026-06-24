import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  PROFILES,
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
    expect(r.model.id).toBe("claude-opus-4-8");
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
