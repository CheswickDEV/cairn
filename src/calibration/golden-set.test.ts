import { describe, it, expect } from "vitest";
import { runGoldenSet, goldenProbes } from "./golden-set.js";
import { makeFixtureCompactor } from "./runner.js";
import { heuristicReviewer } from "./review.js";
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
});
