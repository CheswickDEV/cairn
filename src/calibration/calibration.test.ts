import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCalibration } from "./harness.js";
import { makeFixtureCompactor } from "./runner.js";
import {
  heuristicReviewer,
  assignReviewers,
  computeRecall,
  computeVerbatimScore,
  type Reviewer,
} from "./review.js";
import { applyCalibration, persistArtifact } from "./writer.js";
import { loadGroundTruth } from "./fixtures.js";
import { PROFILES, ModelProfile } from "../core/model-profiles.js";

const ANTHROPIC = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
const FIXED_DATE = "2026-06-21";
const GT = loadGroundTruth();
const COMPACTOR = makeFixtureCompactor(GT);

function offlineRun(candidates = ANTHROPIC) {
  return runCalibration({
    candidates,
    profiles: PROFILES,
    compactor: COMPACTOR,
    reviewer: heuristicReviewer,
    groundTruth: GT,
    date: FIXED_DATE,
    now: () => 0, // deterministic runtime
  });
}

/* --------------------- fixtures sanity --------------------- */

describe("official calibration fixtures", () => {
  it("loads 28 must_survive + 9 must_not_appear with the documented weights", () => {
    expect(GT.mustSurvive.length).toBe(28);
    expect(GT.mustNotAppear.length).toBe(9);
    expect(GT.weights).toEqual({ recall: 0.4, hallucination: 0.3, supersession: 0.15, verbatim: 0.15 });
    // The supersession chains and verbatim blocks are present.
    expect(GT.mustSurvive.filter((i) => i.status === "superseded" || i.status === "discarded").length).toBeGreaterThan(0);
    expect(GT.mustSurvive.filter((i) => i.exact).length).toBe(6);
  });
});

/* --------------------- AK1: reproducible + versioned + dated --------------------- */

describe("reproducible, versioned, dated run", () => {
  it("stamps the date and produces a fidelity/verbosity score per candidate", async () => {
    const a = await offlineRun();
    expect(a.date).toBe(FIXED_DATE);
    expect(a.models.map((m) => m.modelId).sort()).toEqual([...ANTHROPIC].sort());
    for (const m of a.models) {
      expect(m.fidelityScore).toBeGreaterThan(0);
      expect(m.verbosityCoeff).toBeGreaterThan(0);
    }
    // The faithful fixture brief retains everything → fidelity 1.0 and a real floor proposal.
    expect(a.floorProposal).toBe(1);
    expect(a.models.every((m) => m.retainedAllMustSurvive)).toBe(true);
  });

  it("is deterministic: identical inputs → identical artifact", async () => {
    expect(await offlineRun()).toEqual(await offlineRun());
  });

  it("persists a versioned <date>.json artifact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-calib-"));
    try {
      const artifact = await offlineRun();
      const path = persistArtifact(dir, artifact);
      expect(path).toBe(join(dir, `${FIXED_DATE}.json`));
      const written = JSON.parse(readFileSync(path, "utf8"));
      expect(written.date).toBe(FIXED_DATE);
      expect(written.models.length).toBe(ANTHROPIC.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* --------------------- AK2: no self-review --------------------- */

describe("no self-review", () => {
  it("assignReviewers never returns the author and prefers stronger models", () => {
    const strength = (id: string) => ({ a: 0.9, b: 0.8, c: 0.7 })[id] ?? 0;
    const r = assignReviewers("a", ["a", "b", "c"], strength, 2);
    expect(r).not.toContain("a");
    expect(r).toEqual(["b", "c"]);
  });

  it("no model reviews its own brief in a full run", async () => {
    const a = await offlineRun();
    for (const m of a.models) {
      expect(m.reviewers).not.toContain(m.modelId);
      expect(m.reviewers.length).toBeGreaterThanOrEqual(1);
    }
  });
});

/* --------------------- AK3: provisional → calibrated only after a run --------------------- */

describe("provisional vs calibrated lifecycle", () => {
  const fresh: ModelProfile = ModelProfile.parse({
    id: "claude-newcomer-1",
    displayName: "Newcomer",
    ecosystem: "anthropic",
    status: "active",
    isPro: false,
    price: { inputPerMTok: 4, outputPerMTok: 20 },
    context: { window: 1_000_000, maxOutput: 128_000, stdThreshold: null, surcharge: null },
    qualityZone: { greenPct: 0.4, yellowPct: 0.7, provisional: true },
    summarizer: { fidelityScore: null, verbosityCoeff: 1.0, provisionalFidelity: 0.8, calibrated: false },
    sources: [{ label: "internal", date: "2026-06" }],
  });

  it("a newly added model starts provisional (uncalibrated)", () => {
    expect(fresh.summarizer.calibrated).toBe(false);
    expect(fresh.summarizer.fidelityScore).toBeNull();
  });

  it("becomes calibrated only after a run that includes it; others stay provisional", async () => {
    const artifact = await runCalibration({
      candidates: ["claude-newcomer-1", "claude-opus-4-8"],
      profiles: [...PROFILES, fresh],
      compactor: COMPACTOR,
      reviewer: heuristicReviewer,
      groundTruth: GT,
      date: FIXED_DATE,
      now: () => 0,
    });
    const updated = applyCalibration([...PROFILES, fresh], artifact);
    const newcomer = updated.find((p) => p.id === "claude-newcomer-1")!;
    expect(newcomer.summarizer.calibrated).toBe(true);
    expect(newcomer.summarizer.calibrationDate).toBe(FIXED_DATE);
    expect(typeof newcomer.summarizer.fidelityScore).toBe("number");
    // A model NOT in this run keeps its prior state (ollama stays provisional in the seed).
    const ollama = updated.find((p) => p.id === "ollama:local")!;
    expect(ollama.summarizer.calibrated).toBe(false);
  });
});

/* --------------------- AK4: spread → confidence + warning --------------------- */

describe("reviewer spread → confidence + warning", () => {
  const divergentReviewer: Reviewer = async ({ reviewerModelId }) => ({
    recall: reviewerModelId.includes("sonnet") ? 1 : 0,
    hallucination: 1,
    supersession: 1,
  });
  const agreeingReviewer: Reviewer = async () => ({ recall: 1, hallucination: 1, supersession: 1 });

  it("high reviewer spread → warning + reduced confidence (not silent adoption)", async () => {
    const a = await runCalibration({
      candidates: ANTHROPIC,
      profiles: PROFILES,
      compactor: COMPACTOR,
      reviewer: divergentReviewer,
      groundTruth: GT,
      date: FIXED_DATE,
      now: () => 0,
    });
    const opus = a.models.find((m) => m.modelId === "claude-opus-4-8")!;
    // Foreign reviewers (order by measured strength); compared order-independently.
    expect([...opus.reviewers].sort()).toEqual(["claude-haiku-4-5-20251001", "claude-sonnet-4-6"]);
    expect(opus.spread).toBeGreaterThan(0.15);
    expect(opus.highSpreadWarning).toBe(true);
    expect(opus.confidence).toBeLessThan(1);
    expect(a.notes.some((n) => n.includes("claude-opus-4-8"))).toBe(true);
  });

  it("full agreement → confidence 1, no warning", async () => {
    const a = await runCalibration({
      candidates: ANTHROPIC,
      profiles: PROFILES,
      compactor: COMPACTOR,
      reviewer: agreeingReviewer,
      groundTruth: GT,
      date: FIXED_DATE,
      now: () => 0,
    });
    expect(a.models.every((m) => m.confidence === 1)).toBe(true);
    expect(a.models.every((m) => !m.highSpreadWarning)).toBe(true);
    expect(a.notes).toEqual([]);
  });
});

/* --------------------- deterministic metrics against the real key --------------------- */

describe("deterministic recall/verbatim metrics (real fixtures)", () => {
  const allVerbatim = GT.mustSurvive.filter((i) => i.exact).map((i) => i.text).join("\n");
  const allTexts = GT.mustSurvive.map((i) => i.text).join("\n");

  it("computeVerbatimScore is a hard byte-exact check per item", () => {
    expect(computeVerbatimScore(allVerbatim, GT)).toBe(1);
    // Corrupt one byte of the commit hash → that item fails, score drops below 1.
    expect(computeVerbatimScore(allVerbatim.replace("a3f9c21", "a3f9c22"), GT)).toBeLessThan(1);
  });

  it("computeRecall counts present must-survive items", () => {
    expect(computeRecall("nichts Relevantes", GT)).toBe(0);
    expect(computeRecall(allTexts, GT)).toBe(1);
  });
});
