import { describe, it, expect } from "vitest";
import { runGoldenSet, goldenProbes } from "./golden-set.js";
import { makeFixtureCompactor, type Compactor } from "./runner.js";
import { heuristicReviewer, type Reviewer } from "./review.js";
import { PROFILES } from "../core/model-profiles.js";

const ANTHROPIC = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];

function offlineGolden() {
  return runGoldenSet({
    probes: goldenProbes(),
    candidates: ANTHROPIC,
    profiles: PROFILES,
    makeCompactor: (gt) => makeFixtureCompactor(gt),
    reviewer: heuristicReviewer,
    date: "2026-06-22",
    now: () => 0,
  });
}

describe("golden set (multi-probe aggregation)", () => {
  it("has several distinct probes, each with the full trap structure", () => {
    const p = goldenProbes();
    expect(p.length).toBeGreaterThanOrEqual(5);
    expect(new Set(p.map((x) => x.label)).size).toBe(p.length); // labels unique
    // every probe carries supersession + verbatim structure (not just the OCR fixture)
    for (const gp of p) {
      expect(gp.groundTruth.mustSurvive.some((i) => i.status === "superseded")).toBe(true);
      expect(gp.exactSpans.length).toBeGreaterThanOrEqual(2);
      // each exact span must literally occur in its probe (so freezeVerbatim can mask it)
      for (const span of gp.exactSpans) expect(gp.probe).toContain(span);
    }
  });

  it("aggregates per-model fidelity across all probes (offline fixture)", async () => {
    const res = await offlineGolden();
    const labels = goldenProbes().map((p) => p.label);
    expect(res.probes).toEqual(labels);
    expect(res.perModel.map((m) => m.modelId).sort()).toEqual([...ANTHROPIC].sort());
    for (const m of res.perModel) {
      expect(m.probesScored).toBe(labels.length);
      expect(m.perProbe.map((p) => p.label).sort()).toEqual([...labels].sort());
      expect(m.meanFidelity).toBeGreaterThan(0.9); // the faithful fixture retains everything on every probe
    }
    expect(res.floorProposal).not.toBeNull();
  });

  it("is deterministic", async () => {
    expect(await offlineGolden()).toEqual(await offlineGolden());
  });

  it("keeps each probe's scored brief and missed must-survive ids (ADR-0012)", async () => {
    // Per probe, drop its first non-exact must-survive item from the faithful fixture brief.
    const droppedIds = new Set<string>();
    const seen: string[] = [];
    const recording: Reviewer = async (req) => {
      seen.push(req.brief);
      return heuristicReviewer(req);
    };
    const res = await runGoldenSet({
      probes: goldenProbes(),
      candidates: ANTHROPIC,
      profiles: PROFILES,
      makeCompactor: (gt): Compactor => {
        // One keyed fact per probe whose key facts no other line of the fixture brief carries (ADR-0012).
        const drop = gt.mustSurvive.find((i) => ["c_budget", "g2_n_hit", "g3_d_alg0", "g4_d_sync0", "g5_o_hpa"].includes(i.id))!;
        droppedIds.add(drop.id);
        const base = makeFixtureCompactor(gt);
        return async (req) => {
          const r = await base(req);
          return { ...r, brief: r.brief.replace(drop.text, "") };
        };
      },
      reviewer: recording,
      date: "2026-06-22",
      now: () => 0,
    });
    for (const m of res.perModel) {
      for (const p of m.perProbe) {
        expect(p.missingMustSurvive).toHaveLength(1);
        expect(droppedIds.has(p.missingMustSurvive![0])).toBe(true);
        expect(p.retainedAllMustSurvive).toBe(false);
        expect(seen).toContain(p.brief);
      }
    }
  });
});
