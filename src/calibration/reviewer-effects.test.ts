import { describe, it, expect } from "vitest";
import { fitReviewerEffects, type ReviewObservation } from "./score.js";
import { runGoldenSet, goldenProbes, poolGoldenResults, type GoldenResult } from "./golden-set.js";
import { makeFixtureCompactor } from "./runner.js";
import { heuristicReviewer } from "./review.js";
import { PROFILES } from "../core/model-profiles.js";

/* ADR-0012: reviewer leniency/strictness, fitted by least squares and taken out of the scores. */

const MODELS = ["a", "b", "c", "d"];
const QUALITY: Record<string, number> = { a: 0.95, b: 0.94, c: 0.93, d: 0.92 };
const EFFECT: Record<string, number> = { a: 0.03, b: 0.01, c: -0.01, d: -0.03 }; // centred: sums to 0

/** Full matrix without self-review: every model's brief scored by the three others, y = quality + effect. */
function matrix(probes = 2): ReviewObservation[] {
  const obs: ReviewObservation[] = [];
  for (let p = 0; p < probes; p++) {
    for (const author of MODELS) {
      for (const reviewer of MODELS.filter((r) => r !== author)) {
        obs.push({ brief: `${author}|${p}`, reviewer, fidelity: QUALITY[author] + EFFECT[reviewer] });
      }
    }
  }
  return obs;
}

describe("fitReviewerEffects", () => {
  it("recovers the reviewer effects of an additive full matrix exactly", () => {
    const e = fitReviewerEffects(matrix());
    for (const r of MODELS) expect(e.get(r)).toBeCloseTo(EFFECT[r], 12);
    expect([...e.values()].reduce((s, v) => s + v, 0)).toBeCloseTo(0, 12);
  });

  it("removes the self-review gap: raw means are off by −(own effect)/3, corrected means are the quality", () => {
    const obs = matrix();
    const e = fitReviewerEffects(obs);
    for (const author of MODELS) {
      const own = obs.filter((o) => o.brief.startsWith(`${author}|`));
      const raw = own.reduce((s, o) => s + o.fidelity, 0) / own.length;
      const corrected = own.reduce((s, o) => s + o.fidelity - e.get(o.reviewer)!, 0) / own.length;
      expect(raw).toBeCloseTo(QUALITY[author] - EFFECT[author] / 3, 12);
      expect(corrected).toBeCloseTo(QUALITY[author], 12);
    }
  });

  it("has no relative effect for a single reviewer", () => {
    expect([...fitReviewerEffects([{ brief: "x", reviewer: "r", fidelity: 0.9 }])]).toEqual([["r", 0]]);
  });

  it("refuses a design whose reviewers never meet (no connected comparison)", () => {
    const obs: ReviewObservation[] = [
      { brief: "x", reviewer: "r1", fidelity: 0.9 },
      { brief: "y", reviewer: "r2", fidelity: 0.8 },
    ];
    expect(() => fitReviewerEffects(obs)).toThrow(/singular/);
  });
});

/** A synthetic golden artifact over the real probe labels: the matrix above as `perModel`. */
function artifact(): GoldenResult {
  const labels = goldenProbes().map((p) => p.label).slice(0, 2);
  return {
    date: "2026-10-12",
    probes: labels,
    floorProposal: null,
    perModel: MODELS.map((author) => ({
      modelId: `${author}@high`,
      baseModelId: author,
      effort: "high",
      meanFidelity: 0,
      meanConfidence: 0,
      meanVerbosityCoeff: 1,
      highSpreadWarnings: 0,
      probesScored: labels.length,
      perProbe: labels.map((label) => {
        const reviews = MODELS.filter((r) => r !== author).map((r) => {
          const y = QUALITY[author] + EFFECT[r];
          return { reviewerModelId: r, rubric: { recall: y, hallucination: y, supersession: y, verbatim: y }, fidelity: y };
        });
        return {
          label, fidelity: 0, confidence: 1, verbosityCoeff: 1, spread: 0, highSpreadWarning: false, outputTokens: 1,
          retainedAllMustSurvive: false, reviewers: reviews.map((r) => r.reviewerModelId), reviews,
        };
      }),
    })),
  };
}

describe("poolGoldenResults", () => {
  it("fits one set of effects over all runs and returns the corrected quality per model", () => {
    const pooled = poolGoldenResults([artifact(), artifact()]);
    expect(pooled.runs).toBe(2);
    for (const r of MODELS) expect(pooled.reviewerEffects[r]).toBeCloseTo(EFFECT[r], 12);
    for (const m of pooled.perModel) {
      expect(m.probeRuns).toBe(4);
      expect(m.meanFidelityAdjusted).toBeCloseTo(QUALITY[m.baseModelId], 12);
      expect(m.meanConfidenceAdjusted).toBeCloseTo(1, 12); // y − effect is constant per brief
    }
    expect(pooled.floorProposalAdjusted).toBeCloseTo((0.94 + 0.93) / 2, 12);
  });

  it("re-checks stored briefs against the current ground truth; a brief-less probe run counts as n/a", () => {
    const pooled = poolGoldenResults([artifact()]);
    for (const m of pooled.perModel) expect(m.missingMustSurvive).toBeNull();
  });

  it("refuses artifacts without reviews", () => {
    const a = artifact();
    for (const m of a.perModel) for (const p of m.perProbe) p.reviews = [];
    expect(() => poolGoldenResults([a])).toThrow(/no reviews/);
  });
});

describe("runGoldenSet records the correction (ADR-0012)", () => {
  it("adds reviewer effects and corrected values; with an unbiased reviewer they equal the raw ones", async () => {
    const res = await runGoldenSet({
      probes: goldenProbes(),
      candidates: ["claude-fable-5-1@high", "claude-opus-5-5@high", "gpt-6.1-sol@high"],
      profiles: PROFILES,
      makeCompactor: (gt) => makeFixtureCompactor(gt),
      reviewer: heuristicReviewer,
      reviewerPool: ["claude-fable-5-1", "claude-opus-5-5", "gpt-6.1-sol"],
      reviewersPerBrief: 2,
      date: "2026-10-12",
      now: () => 0,
    });
    expect(Object.keys(res.reviewerEffects ?? {}).sort()).toEqual(["claude-fable-5-1", "claude-opus-5-5", "gpt-6.1-sol"]);
    for (const v of Object.values(res.reviewerEffects!)) expect(v).toBeCloseTo(0, 12);
    for (const m of res.perModel) {
      expect(m.meanFidelityAdjusted).toBeCloseTo(m.meanFidelity, 12);
      for (const p of m.perProbe) expect(p.fidelityAdjusted).toBeCloseTo(p.fidelity, 12);
    }
    const pooled = poolGoldenResults([res]);
    for (const m of pooled.perModel) {
      expect(m.missingMustSurvive).toBe(0); // fixture briefs carry every key fact and every verbatim span
      expect(m.briefsRetainingAll).toBe(m.probeRuns);
    }
  });
});
