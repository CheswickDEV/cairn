import { describe, it, expect } from "vitest";
import {
  PROFILES,
  CONTEXT_ONLY_PROFILES,
  FIDELITY_FLOOR,
  ModelProfile,
  resolveProfile,
  effectiveCost,
  selectSummarizer,
  summarizerPool,
  type CostInput,
  type Zone,
} from "./model-profiles";
import { buildVariants } from "../calibration/variants.js";
import { runHandoff } from "../tools/handoff.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { loadConfig } from "./config.js";

/* ------------------------------------------------------------------ */
/* ADR-0012: the summarizer pool = the current generation              */
/* ------------------------------------------------------------------ */

function profile(id: string): ModelProfile {
  const p = PROFILES.find((x) => x.id === id);
  if (!p) throw new Error(`profile '${id}' missing`);
  return p;
}

/** Uncalibrated view (verbosity 1.0), so the cost math stays stable after the Phase-6 calibration. */
const PROVISIONAL = PROFILES.map((p) => ({
  ...p,
  summarizer: { ...p.summarizer, fidelityScore: null, calibrated: false, verbosityCoeff: 1.0 },
}));
const prov = (id: string) => PROVISIONAL.find((p) => p.id === id)!;

const SUSPENDED = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
];

describe("pool profiles carry the documented data (Anthropic/OpenAI docs, 2026-10-11)", () => {
  // id, ecosystem, window, maxOutput, [in, out, cacheRead, batchIn, batchOut], stdThreshold, surcharge
  const ROWS: [string, string, number, number, number[], number | null, { inputMult: number; outputMult: number } | null][] = [
    ["claude-fable-5-1", "anthropic", 1_000_000, 128_000, [10, 50, 0.25, 5, 25], null, null],
    ["claude-opus-5-5", "anthropic", 1_000_000, 128_000, [4, 20, 0.2, 2, 10], null, null],
    ["claude-sonnet-5-5", "anthropic", 1_000_000, 128_000, [2, 10, 0.1, 1, 5], null, null],
    ["claude-haiku-5-5", "anthropic", 1_000_000, 128_000, [0.1, 0.5, 0.01, 0.05, 0.25], 100_000, { inputMult: 5, outputMult: 5 }],
    ["gpt-6-astra", "openai", 1_050_000, 128_000, [10, 50, 1, 5, 25], 272_000, { inputMult: 2, outputMult: 1.5 }],
    ["gpt-6.1-sol", "openai", 1_050_000, 128_000, [2, 10, 0.1, 1, 5], 272_000, { inputMult: 2, outputMult: 1.5 }],
    ["gpt-6-luna", "openai", 1_050_000, 128_000, [0.1, 0.5, 0.01, 0.05, 0.25], 272_000, { inputMult: 2, outputMult: 1.5 }],
  ];

  it.each(ROWS)("%s", (id, ecosystem, window, maxOutput, [i, o, c, bi, bo], stdThreshold, surcharge) => {
    const p = profile(id);
    expect(p.ecosystem).toBe(ecosystem);
    expect(p.status).toBe("active");
    expect(p.isPro).toBe(false);
    expect(p.context).toEqual({ window, maxOutput, stdThreshold, surcharge });
    expect(p.price).toEqual({ inputPerMTok: i, outputPerMTok: o, cacheReadPerMTok: c, batchInputPerMTok: bi, batchOutputPerMTok: bo });
    expect(resolveProfile(id)).toBe(p);
  });
});

describe("long-context tiers in effectiveCost", () => {
  const at = (inputTokens: number, useBatch = false): CostInput => ({ inputTokens, expectedBriefTokens: 6_000, useBatch });

  it("Haiku 5.5: base price up to 100K, 5x on the whole request above (Batch too)", () => {
    const h = prov("claude-haiku-5-5");
    // 90K: 0.09M*$0.10 + 0.006M*$0.50 = 0.009 + 0.003 = 0.012 ; Batch 0.0045 + 0.0015 = 0.006
    expect(effectiveCost(h, at(90_000))).toBeCloseTo(0.012, 9);
    expect(effectiveCost(h, at(90_000, true))).toBeCloseTo(0.006, 9);
    // exactly 100K is not "over 100,000": base price
    expect(effectiveCost(h, at(100_000))).toBeCloseTo(0.01 + 0.003, 9);
    // 150K: 0.15M*$0.50 + 0.006M*$2.50 = 0.075 + 0.015 = 0.09 ; Batch 0.15M*$0.25 + 0.006M*$1.25 = 0.045
    expect(effectiveCost(h, at(150_000))).toBeCloseTo(0.09, 9);
    expect(effectiveCost(h, at(150_000, true))).toBeCloseTo(0.045, 9);
  });

  it.each([
    ["gpt-6-astra", 10, 50, 5, 25],
    ["gpt-6.1-sol", 2, 10, 1, 5],
    ["gpt-6-luna", 0.1, 0.5, 0.05, 0.25],
  ])("%s: no surcharge at 200K; above 272K 2x input and 1.5x output (Batch too)", (id, i, o, bi, bo) => {
    const p = prov(id);
    expect(effectiveCost(p, at(200_000))).toBeCloseTo(0.2 * i + 0.006 * o, 9);
    expect(effectiveCost(p, at(300_000))).toBeCloseTo(0.3 * i * 2 + 0.006 * o * 1.5, 9);
    expect(effectiveCost(p, at(300_000, true))).toBeCloseTo(0.3 * bi * 2 + 0.006 * bo * 1.5, 9);
  });

  it("the flat Claude models have no tier", () => {
    for (const id of ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"]) {
      const p = prov(id);
      expect(effectiveCost(p, { inputTokens: 900_000, expectedBriefTokens: 0 })).toBeCloseTo(0.9 * p.price.inputPerMTok, 9);
    }
  });
});

describe("pool composition (ADR-0012)", () => {
  it("active Anthropic profiles are exactly the four current Claude models", () => {
    const ids = summarizerPool().filter((p) => p.ecosystem === "anthropic").map((p) => p.id).sort();
    expect(ids).toEqual(["claude-fable-5-1", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(PROFILES.filter((p) => p.status === "active" && p.ecosystem === "anthropic").length).toBe(4);
  });

  it("active OpenAI profiles are exactly GPT-6 Astra, GPT-6.1 Sol and GPT-6 Luna", () => {
    const ids = summarizerPool().filter((p) => p.ecosystem === "openai").map((p) => p.id).sort();
    expect(ids).toEqual(["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"]);
    expect(PROFILES.filter((p) => p.status === "active" && p.ecosystem === "openai").length).toBe(3);
  });

  it("the only context-only entry left is gpt-6-sol", () => {
    expect(CONTEXT_ONLY_PROFILES.map((p) => p.id)).toEqual(["gpt-6-sol"]);
    expect(resolveProfile("gpt-6-sol").context.window).toBe(1_050_000);
  });

  it("every earlier-generation profile is suspended, with its history kept", () => {
    for (const id of SUSPENDED) expect(profile(id).status).toBe("suspended");
    expect(profile("claude-haiku-4-5-20251001").summarizer.fidelityScore).toBe(0.98);
    expect(profile("gpt-5.5").summarizer.calibrated).toBe(true);
    for (const id of SUSPENDED.filter((x) => x !== "claude-fable-5")) {
      expect(profile(id).notes).toContain("suspended 2026-10");
    }
  });
});

describe("suspended models (ADR-0012)", () => {
  const cost: CostInput = { inputTokens: 180_000, expectedBriefTokens: 6_000 };
  const hosts = [
    { modelId: "claude-opus-4-8" },
    { modelId: "claude-haiku-4-5-20251001" },
    { modelId: "claude-opus-5-5" },
    { modelId: "gpt-5.5" },
    { modelId: "gpt-5.4-pro" },
    { modelId: "gpt-6.1-sol" },
    { provider: "openai" },
  ];

  it("are never selected (hosts × zones × floors, even when everything counts as reachable)", async () => {
    for (const host of hosts) {
      for (const sourceZone of ["green", "yellow", "red"] as Zone[]) {
        for (const fidelityFloor of [0, 0.5, FIDELITY_FLOOR]) {
          for (const reachable of [undefined, async () => true]) {
            const r = await selectSummarizer({ host, sourceZone, cost, fidelityFloor, reachable });
            if (r.kind === "model") {
              expect(SUSPENDED).not.toContain(r.model.id);
              expect(r.model.status).toBe("active");
            }
          }
        }
      }
    }
  });

  it("are never calibration variants", () => {
    const bases = new Set(buildVariants().map((v) => v.baseModelId));
    for (const id of SUSPENDED) expect(bases.has(id)).toBe(false);
    expect([...bases].sort()).toEqual(summarizerPool().map((p) => p.id).sort());
  });

  it.each([
    ["claude-opus-4-8", 1_000_000],
    ["claude-opus-4-8[1m]", 1_000_000],
    ["claude-sonnet-4-6", 1_000_000],
    ["claude-haiku-4-5", 200_000],
    ["claude-haiku-4-5-20251001", 200_000],
    ["gpt-5.5", 1_050_000],
    ["gpt-5.5-codex", 1_050_000],
    ["gpt-5.5-pro", 1_050_000],
    ["gpt-5.4", 1_050_000],
  ])("still resolve with the right window: %s → %i", (id, window) => {
    const p = resolveProfile(id);
    expect(p.status).toBe("suspended");
    expect(p.context.window).toBe(window);
  });
});

// Phase 6 (ADR-0012): the provisional transition block is replaced by the calibrated selection. Basis:
// golden set 2026-10-12, two runs pooled, scored by the foreign-family reviewers only; floor 0.84 signed
// off by the user so that Opus 5.5 and GPT-6.1 Sol compact in every zone (red = floor + 0.10 = 0.94).
describe("calibrated selection (ADR-0012, golden set 2026-10-12, floor 0.84)", () => {
  const cost: CostInput = { inputTokens: 180_000, expectedBriefTokens: 6_000 };
  const ZONES: Zone[] = ["green", "yellow", "red"];
  const pick = (host: { modelId?: string; provider?: string }, sourceZone: Zone, reachable?: (p: ModelProfile) => Promise<boolean>) =>
    selectSummarizer({ host, sourceZone, cost, fidelityFloor: FIDELITY_FLOOR, reachable });

  // id, fidelityScore, verbosityCoeff, confidence (foreign reviewers, 10 probe runs each)
  const MEASURED: [string, number, number, number][] = [
    ["claude-fable-5-1", 0.9298, 1.13, 0.99],
    ["claude-opus-5-5", 0.9416, 1.11, 0.99],
    ["claude-sonnet-5-5", 0.9183, 1.10, 0.98],
    ["claude-haiku-5-5", 0.9123, 1.15, 0.98],
    ["gpt-6-astra", 0.9697, 0.90, 0.98],
    ["gpt-6.1-sol", 0.9655, 0.88, 0.98],
    ["gpt-6-luna", 0.9486, 0.76, 0.98],
  ];

  it.each(MEASURED)("%s carries the measured values at effort 'high'", (id, fidelity, verbosity, confidence) => {
    expect(profile(id).summarizer).toEqual({
      fidelityScore: fidelity,
      verbosityCoeff: verbosity,
      provisionalFidelity: profile(id).summarizer.provisionalFidelity,
      calibrated: true,
      calibrationDate: "2026-10-12",
      confidence,
      effort: "high",
    });
  });

  it("the signed-off floor is 0.84, and both picks clear its red-zone escalation", () => {
    expect(FIDELITY_FLOOR).toBe(0.84);
    expect(profile("claude-opus-5-5").summarizer.fidelityScore!).toBeGreaterThanOrEqual(FIDELITY_FLOOR + 0.10);
    expect(profile("gpt-6.1-sol").summarizer.fidelityScore!).toBeGreaterThanOrEqual(FIDELITY_FLOOR + 0.10);
  });

  it("Claude host: Opus 5.5 in every zone (Fable 5.1 shares the band, Opus is cheaper; Sonnet and Haiku are outside)", async () => {
    for (const zone of ZONES) {
      const r = await pick({ modelId: "claude-opus-5-5" }, zone);
      expect(r.kind === "model" && r.model.id).toBe("claude-opus-5-5");
      expect(r.kind === "model" && r.reason).toContain("calibrated");
    }
  });

  it("Codex host: GPT-6.1 Sol in every zone (Astra shares the band, Sol is cheaper; Luna is 0.0211 below Astra)", async () => {
    for (const zone of ZONES) {
      const r = await pick({ provider: "openai", modelId: "gpt-6.1-sol" }, zone);
      expect(r.kind === "model" && r.model.id).toBe("gpt-6.1-sol");
    }
  });

  // Deliberately recorded (user sign-off 2026-10-12): without Opus the band reaches down to Haiku 5.5,
  // the cheapest, whose 0.9123 clears green and yellow but not red (0.94) → verbatim in red.
  it("Claude host without Opus 5.5: Haiku 5.5 in green and yellow, red → verbatim", async () => {
    const noOpus = async (p: ModelProfile) => p.status === "active" && p.id !== "claude-opus-5-5";
    for (const zone of ["green", "yellow"] as Zone[]) {
      const r = await pick({ modelId: "claude-opus-5-5" }, zone, noOpus);
      expect(r.kind === "model" && r.model.id).toBe("claude-haiku-5-5");
    }
    const red = await pick({ modelId: "claude-opus-5-5" }, "red", noOpus);
    expect(red.kind).toBe("verbatim-fallback");
    expect(red.reason).toContain("below effective floor");
  });

  it("Codex host without GPT-6.1 Sol: Astra in every zone (Luna stays outside the band)", async () => {
    const noSol = async (p: ModelProfile) => p.status === "active" && p.id !== "gpt-6.1-sol";
    for (const zone of ZONES) {
      const r = await pick({ modelId: "gpt-6.1-sol" }, zone, noSol);
      expect(r.kind === "model" && r.model.id).toBe("gpt-6-astra");
    }
  });

  it("never crosses ecosystems, also from a suspended host model", async () => {
    for (const zone of ZONES) {
      for (const id of ["claude-opus-4-8", "claude-haiku-5-5", "claude-fable-5-1"]) {
        const r = await pick({ modelId: id }, zone);
        expect(r.kind === "model" && r.model.ecosystem).toBe("anthropic");
      }
      for (const id of ["gpt-5.5", "gpt-6-luna", "gpt-6-astra"]) {
        const r = await pick({ modelId: id }, zone);
        expect(r.kind === "model" && r.model.ecosystem).toBe("openai");
      }
    }
  });

  it("runHandoff without a zone assumes red → Opus 5.5 (no verbatim); account mode stores the brief without egress", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const r = await runHandoff({ brief: "1) DECISIONS x", host: { modelId: "claude-opus-5-5" } }, { store, config: loadConfig({}) });
    expect(r.selectionKind).toBe("model");
    expect(r.modelId).toBe("claude-opus-5-5");
    expect(r.egress).toBe(false);
    expect(store.getDecision(r.storedDecisionId)?.rationale).toBe("1) DECISIONS x");
  });
});

describe("selection with synthetic calibration values (profiles fixture)", () => {
  const cost: CostInput = { inputTokens: 180_000, expectedBriefTokens: 6_000 };
  const calibrated = (scores: Record<string, number>): ModelProfile[] =>
    PROVISIONAL.filter((p) => p.id in scores).map((p) => ({
      ...p,
      summarizer: { ...p.summarizer, fidelityScore: scores[p.id], calibrated: true },
    }));
  const run = (profiles: ModelProfile[], extra: Partial<Parameters<typeof selectSummarizer>[0]> = {}) =>
    selectSummarizer({ host: { modelId: "claude-opus-5-5" }, sourceZone: "green", cost, fidelityFloor: 0.85, profiles, ...extra });

  it("band + cost tiebreak: Haiku 5.5 is the cheapest model inside the 0.02 band", async () => {
    const r = await run(calibrated({ "claude-fable-5-1": 0.975, "claude-opus-5-5": 0.97, "claude-sonnet-5-5": 0.98, "claude-haiku-5-5": 0.965 }));
    expect(r.kind === "model" && r.model.id).toBe("claude-haiku-5-5");
  });

  it("a clearly better model outside the band wins despite its price", async () => {
    const r = await run(calibrated({ "claude-fable-5-1": 0.99, "claude-opus-5-5": 0.96, "claude-sonnet-5-5": 0.96, "claude-haiku-5-5": 0.95 }));
    expect(r.kind === "model" && r.model.id).toBe("claude-fable-5-1");
  });

  it("the Haiku 5.5 tier can flip the tiebreak above 100K input", async () => {
    // A synthetic flat $0.30/$1.50 Claude model with equal fidelity: Haiku 5.5 is cheaper up to 100K,
    // above it Haiku costs 5x ($0.50/$2.50) and the flat model wins.
    const [haiku] = calibrated({ "claude-haiku-5-5": 0.97 });
    const flat: ModelProfile = {
      ...haiku,
      id: "claude-flat-synthetic",
      price: { inputPerMTok: 0.3, outputPerMTok: 1.5 },
      context: { ...haiku.context, stdThreshold: null, surcharge: null },
    };
    const below = await run([haiku, flat], { cost: { inputTokens: 90_000, expectedBriefTokens: 6_000 } });
    const above = await run([haiku, flat], { cost: { inputTokens: 150_000, expectedBriefTokens: 6_000 } });
    expect(below.kind === "model" && below.model.id).toBe("claude-haiku-5-5");
    expect(above.kind === "model" && above.model.id).toBe("claude-flat-synthetic");
  });

  it("floor + red escalation: below 0.95 in red → verbatim with the floor reason; at 0.96 → model", async () => {
    const weak = await run(calibrated({ "claude-opus-5-5": 0.93 }), { sourceZone: "red" });
    expect(weak.kind).toBe("verbatim-fallback");
    expect(weak.reason).toContain("below effective floor");
    const strong = await run(calibrated({ "claude-opus-5-5": 0.96 }), { sourceZone: "red" });
    expect(strong.kind === "model" && strong.model.id).toBe("claude-opus-5-5");
  });
});
