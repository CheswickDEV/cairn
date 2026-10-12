import { describe, it, expect } from "vitest";
import { fitReviewerEffects, type ReviewObservation } from "./score.js";
import { runGoldenSet, goldenProbes, poolGoldenResults, checkPoolInputs, type GoldenResult } from "./golden-set.js";
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

describe("the correction never costs a run its artifact (ADR-0012)", () => {
  it("one reviewer per brief: the effects cannot be fitted, the golden result says why and keeps its values", async () => {
    const res = await runGoldenSet({
      probes: goldenProbes(),
      candidates: ["claude-fable-5-1@high", "claude-opus-5-5@high", "gpt-6.1-sol@high"],
      profiles: PROFILES,
      makeCompactor: (gt) => makeFixtureCompactor(gt),
      reviewer: heuristicReviewer,
      reviewerPool: ["claude-fable-5-1", "claude-opus-5-5", "gpt-6.1-sol"],
      reviewersPerBrief: 1,
      date: "2026-10-12",
      now: () => 0,
    });
    expect(res.reviewerEffectsSkipped).toMatch(/singular/);
    expect(res.reviewerEffects).toBeUndefined();
    expect(res.perModel).toHaveLength(3);
    for (const m of res.perModel) expect(m.meanFidelityAdjusted).toBeUndefined();
  });

  it("a probe run without any review stays out of the pooled corrected mean", () => {
    const a = artifact();
    a.perModel[0].perProbe[0].reviews = [];
    const m = poolGoldenResults([a]).perModel.find((x) => x.baseModelId === "a")!;
    expect(Number.isFinite(m.meanFidelityAdjusted)).toBe(true);
    expect(Number.isFinite(poolGoldenResults([a]).floorProposalAdjusted!)).toBe(true);
  });
});

describe("checkPoolInputs", () => {
  const input = (path: string, sha256: string, res: GoldenResult) => ({ path, sha256, res });
  // A second run of the same configuration: same probes and models, another brief.
  const rerun = () => {
    const b = artifact();
    b.perModel[0].perProbe[0].brief = "another brief";
    return b;
  };
  it("accepts two runs of the same configuration and notes missing probe hashes", () => {
    expect(checkPoolInputs([input("a", "1", artifact()), input("b", "2", rerun())])).toEqual([
      "a: no probeInfo (written before it was recorded), so its probe contents are not compared",
      "b: no probeInfo (written before it was recorded), so its probe contents are not compared",
    ]);
    const withInfo = (r: GoldenResult) => ({ ...r, probeInfo: [{ sha256: "p" }] }) as GoldenResult;
    expect(checkPoolInputs([input("a", "1", withInfo(artifact())), input("b", "2", withInfo(rerun()))])).toEqual([]);
  });
  it.each([
    ["re-serialized with other key order", (c: GoldenResult): void => {
      c.perModel = c.perModel.map((m) => Object.fromEntries(Object.entries(m).reverse()) as typeof m);
    }],
    ["with the models reordered", (c: GoldenResult): void => void c.perModel.reverse()],
    ["with the probes reordered", (c: GoldenResult): void => c.perModel.forEach((m) => m.perProbe.reverse())],
    ["re-scored (derived fields changed or added)", (c: GoldenResult): void => c.perModel.forEach((m) => {
      m.meanFidelity = 0.1;
      (m as unknown as Record<string, unknown>).extra = true;
      m.perProbe.forEach((p) => { p.fidelity = 0.2; p.missingMustSurvive = ["x"]; p.retainedAllMustSurvive = true; });
    })],
  ] as const)("refuses a copy of the same run %s (same briefs and reviews)", (_, change) => {
    const a = rerun();
    const copy = JSON.parse(JSON.stringify({ ...a, date: "2026-10-13" })) as GoldenResult;
    change(copy);
    expect(() => checkPoolInputs([input("a", "1", a), input("b", "2", copy)])).toThrow(/b: the same run as a \(identical results\)/);
  });
  it.each([
    ["with the reviews of a probe reordered", (c: GoldenResult): void => c.perModel.forEach((m) => m.perProbe.forEach((p) => p.reviews.reverse()))],
    ["with the review fidelities recomputed", (c: GoldenResult): void => c.perModel.forEach((m) => m.perProbe.forEach((p) => p.reviews.forEach((v) => {
      v.fidelity = 0.123;
      v.rubric.verbatim = 0.5;
    })))],
  ] as const)("refuses a copy of the same run %s (same reviewer scores)", (_, change) => {
    const a = rerun();
    const copy = JSON.parse(JSON.stringify(a)) as GoldenResult;
    change(copy);
    expect(() => checkPoolInputs([input("a", "1", a), input("b", "2", copy)])).toThrow(/the same run as a/);
  });
  it("accepts two old runs without briefs and reviews that differ, and refuses an entry without probes", () => {
    const old = (fidelity: number) => {
      const r = artifact();
      r.perModel.forEach((m) => m.perProbe.forEach((p) => { p.reviews = []; p.fidelity = fidelity; }));
      return r;
    };
    expect(() => checkPoolInputs([input("a", "1", old(0.9)), input("b", "2", old(0.8))])).not.toThrow();
    const broken = artifact();
    (broken.perModel[0] as unknown as Record<string, unknown>).perProbe = undefined;
    expect(() => checkPoolInputs([input("x", "1", broken)])).toThrow(/x: not a golden artifact/);
  });
  it("compares probe contents against the first input that records them, after one without", () => {
    const withInfo = (r: GoldenResult, sha: string) => ({ ...r, probeInfo: [{ sha256: sha }] }) as GoldenResult;
    const third = artifact();
    third.perModel[1].perProbe[0].brief = "a third brief";
    expect(() =>
      checkPoolInputs([input("a", "1", artifact()), input("b", "2", withInfo(rerun(), "p")), input("c", "3", withInfo(third, "q"))]),
    ).toThrow(/c: other probe contents than b/);
  });
  it.each([
    ["the same artifact twice", (b: GoldenResult) => b, "1", /the same artifact twice/],
    ["other probes", (b: GoldenResult) => ({ ...b, probes: ["x"] }), "2", /other probes/],
    ["other models", (b: GoldenResult) => ({ ...b, perModel: b.perModel.slice(1) }), "2", /other models/],
    ["another reviewer effort", (b: GoldenResult) => ({ ...b, reviewerEffort: "xhigh" }), "2", /other reviewer effort/],
    ["other probe contents", (b: GoldenResult) => ({ ...b, probeInfo: [{ sha256: "x" }] }), "2", /other probe contents/],
  ] as const)("refuses %s", (_, change, sha, error) => {
    const first = { ...artifact(), reviewerEffort: "high", probeInfo: [{ sha256: "p" }] } as GoldenResult;
    const second = { ...rerun(), reviewerEffort: "high", probeInfo: [{ sha256: "p" }] } as GoldenResult;
    expect(() => checkPoolInputs([input("a", "1", first), input("b", sha, change(sha === "1" ? { ...first } : second))])).toThrow(error);
  });
  it("refuses an empty list and a non-golden file", () => {
    expect(() => checkPoolInputs([])).toThrow(/at least one/);
    expect(() => checkPoolInputs([input("x", "1", {} as GoldenResult)])).toThrow(/not a golden artifact/);
  });
});
