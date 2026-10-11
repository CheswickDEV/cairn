import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILES, summarizerPool } from "../core/model-profiles.js";
import {
  CALIB_POOL,
  LARGE_VARIANTS,
  LARGE_REVIEWER_POOL,
  resolveCalibConfig,
  assertCalibPreflight,
  artifactSuffix,
  type CalibConfig,
} from "./calib-config.js";
import { runCalibration } from "./harness.js";
import { runGoldenSet, goldenProbes } from "./golden-set.js";
import { persistArtifact } from "./writer.js";
import { makeFixtureCompactor, estimateTokens, type Compactor } from "./runner.js";
import { heuristicReviewer, type Reviewer } from "./review.js";
import { loadGroundTruth, loadProbeContext } from "./fixtures.js";
import { BRIDGE_WINDOWS, partitionByWindow } from "./window-fit.js";
import { buildLargeProbe, LARGE_GROUND_TRUTH } from "./large-probe.js";
import { parseVariant, cliModelName } from "./variants.js";

const GT = loadGroundTruth();
const REAL = ["node", "cli.ts", "--real"];
const isClaude = (id: string) => id.startsWith("claude-");

describe("calibration pool + defaults (ADR-0012)", () => {
  it("CALIB_POOL is the summarizer pool; LARGE_VARIANTS is the pool at @high", () => {
    expect([...CALIB_POOL].sort()).toEqual(summarizerPool().map((p) => p.id).sort());
    expect(LARGE_VARIANTS).toEqual(CALIB_POOL.map((id) => `${id}@high`));
    expect(LARGE_REVIEWER_POOL).toEqual(CALIB_POOL);
  });

  it.each([
    ["single", [...REAL]],
    ["golden", [...REAL, "--golden"]],
    ["large", [...REAL, "--probe", "large"]],
  ])("live %s run: 7 candidates @high, reviewer pool = the 7, k = 6, reviewer effort high", (probe, argv) => {
    const cfg = resolveCalibConfig({}, argv);
    expect(cfg.mode).toBe("real");
    expect(cfg.probe).toBe(probe);
    expect([...cfg.candidates].sort()).toEqual([...LARGE_VARIANTS].sort());
    expect(cfg.reviewerPool).toEqual([...CALIB_POOL]);
    expect(cfg.reviewersPerBrief).toBe(6);
    expect(cfg.reviewerEffort).toBe("high");
  });

  it("--dry-run resolves the same live configuration", () => {
    const real = resolveCalibConfig({}, [...REAL, "--golden"]);
    const dry = resolveCalibConfig({}, ["node", "cli.ts", "--dry-run", "--golden"]);
    expect({ ...dry, mode: "real" }).toEqual(real);
    expect(() => resolveCalibConfig({}, [...REAL, "--dry-run"])).toThrow(/exclude each other/);
  });

  it("offline mode keeps its fixture behaviour (no effort, harness reviewer default)", () => {
    const cfg = resolveCalibConfig({}, ["node", "cli.ts"]);
    expect(cfg.mode).toBe("offline");
    expect(cfg.candidates).toEqual(PROFILES.filter((p) => p.status === "active").map((p) => p.id));
    expect(cfg.reviewerPool).toBeUndefined();
    expect(cfg.reviewersPerBrief).toBe(2);
  });

  it("cliModelName passes the new pool ids unchanged", () => {
    for (const id of CALIB_POOL) expect(cliModelName(id)).toBe(id);
  });
});

describe("resolveCalibConfig rejects every violation before a model call", () => {
  const bad: [string, Record<string, string>, RegExp][] = [
    ["a suspended candidate", { CAIRN_CALIB_VARIANTS: "claude-opus-4-8@high" }, /suspended/],
    ["a suspended reviewer", { CAIRN_CALIB_REVIEWER_POOL: "claude-opus-5-5,gpt-5.5" }, /suspended/],
    ["a context-only model", { CAIRN_CALIB_VARIANTS: "gpt-6-sol@high" }, /unknown model/],
    ["the local fallback", { CAIRN_CALIB_VARIANTS: "ollama:local@high" }, /not in the calibration pool/],
    ["an id without effort", { CAIRN_CALIB_VARIANTS: "claude-opus-5-5" }, /exactly 'high'/],
    ["a candidate below high", { CAIRN_CALIB_VARIANTS: "gpt-6-luna@medium" }, /exactly 'high'/],
    ["a candidate above high", { CAIRN_CALIB_VARIANTS: "gpt-6-luna@xhigh" }, /exactly 'high'/],
    ["a mis-cased effort", { CAIRN_CALIB_VARIANTS: "gpt-6-luna@High" }, /exactly 'high'/],
    ["an env effort tier below high", { CAIRN_CALIB_EFFORTS_ANTHROPIC: "medium" }, /below the 'high' minimum/],
    ["an env effort tier above high", { CAIRN_CALIB_EFFORTS_OPENAI: "xhigh" }, /exactly 'high'/],
    ["a reviewer effort below high", { CAIRN_CALIB_REVIEWER_EFFORT: "medium" }, /exactly 'high'/],
    ["a reviewer effort above high", { CAIRN_CALIB_REVIEWER_EFFORT: "xhigh" }, /exactly 'high'/],
    ["an empty reviewer effort", { CAIRN_CALIB_REVIEWER_EFFORT: "" }, /exactly 'high'/],
    ["a NaN reviewer count", { CAIRN_CALIB_REVIEWERS: "abc" }, /positive integer/],
    ["zero reviewers", { CAIRN_CALIB_REVIEWERS: "0" }, /positive integer/],
    ["a fractional reviewer count", { CAIRN_CALIB_REVIEWERS: "2.5" }, /positive integer/],
    ["a NaN concurrency", { CAIRN_CALIB_CONCURRENCY: "x" }, /positive integer/],
    ["a duplicate candidate", { CAIRN_CALIB_VARIANTS: "gpt-6-luna@high,gpt-6-luna@high" }, /duplicate/],
    ["a one-model reviewer pool", { CAIRN_CALIB_REVIEWER_POOL: "gpt-6-luna" }, /at least 2/],
  ];
  it.each(bad)("%s", (_, env, msg) => {
    expect(() => resolveCalibConfig(env, [...REAL, "--golden"])).toThrow(msg);
  });

  it("a reviewer pool entry `x@high` is normalised to its base id", () => {
    const cfg = resolveCalibConfig({ CAIRN_CALIB_REVIEWER_POOL: "claude-opus-5-5@high,gpt-6.1-sol,gpt-6.1-sol@high" }, REAL);
    expect(cfg.reviewerPool).toEqual(["claude-opus-5-5", "gpt-6.1-sol"]);
    expect(cfg.reviewersPerBrief).toBe(1);
  });

  it("the pre-flight re-checks candidates, LARGE_VARIANTS, reviewer effort and pool ids", () => {
    const ok: Pick<CalibConfig, "candidates" | "reviewerEffort" | "reviewerPool"> = {
      candidates: [...LARGE_VARIANTS],
      reviewerEffort: "high",
      reviewerPool: [...CALIB_POOL],
    };
    expect(() => assertCalibPreflight(ok)).not.toThrow();
    expect(() => assertCalibPreflight({ ...ok, candidates: ["claude-opus-5-5@medium"] })).toThrow(/below the 'high' minimum/);
    expect(() => assertCalibPreflight({ ...ok, candidates: ["claude-opus-5-5@max"] })).toThrow(/exactly 'high'/);
    expect(() => assertCalibPreflight({ ...ok, reviewerEffort: "xhigh" })).toThrow(/exactly 'high'/);
    expect(() => assertCalibPreflight({ ...ok, reviewerPool: ["gpt-6-luna@high"] })).toThrow(/base model id/);
  });
});

/* ------------------------------- reviewer matrix ------------------------------- */

describe("full reviewer matrix (k = 6, never self)", () => {
  const cfg = resolveCalibConfig({}, REAL);
  const brief: Compactor = async () => ({ brief: "1) DECISIONS x", outputTokens: 300 });

  it("every brief is reviewed by all 6 other pool models, never by its own", async () => {
    const seen: [string, string][] = [];
    const reviewer: Reviewer = async ({ authorModelId, reviewerModelId }) => {
      seen.push([authorModelId, reviewerModelId]);
      return { recall: 1, hallucination: 1, supersession: 1 };
    };
    const a = await runCalibration({ candidates: cfg.candidates, profiles: PROFILES, compactor: brief, reviewer, reviewerPool: cfg.reviewerPool, reviewersPerBrief: cfg.reviewersPerBrief, groundTruth: GT, date: "2026-10-11", now: () => 0 });
    expect(a.models).toHaveLength(7);
    expect(seen).toHaveLength(42);
    for (const m of a.models) {
      expect([...m.reviewers].sort()).toEqual(CALIB_POOL.filter((id) => id !== m.baseModelId).sort());
      expect(m.reviewers).not.toContain(m.baseModelId);
      // cross-ecosystem: Claude briefs get the GPT-6 reviewers and vice versa
      const foreign = m.reviewers.filter((r) => isClaude(r) !== isClaude(m.baseModelId));
      expect(foreign).toHaveLength(isClaude(m.baseModelId) ? 3 : 4);
    }
  });

  it("an `x@high` pool entry never reviews its own model's brief (harness normalises too)", async () => {
    const a = await runCalibration({
      candidates: ["claude-opus-5-5@high", "gpt-6.1-sol@high"],
      profiles: PROFILES,
      compactor: brief,
      reviewer: heuristicReviewer,
      reviewerPool: ["claude-opus-5-5@high", "gpt-6.1-sol@high"],
      reviewersPerBrief: 6,
      groundTruth: GT,
      date: "2026-10-11",
      now: () => 0,
    });
    for (const m of a.models) expect(m.reviewers).toEqual([m.baseModelId === "claude-opus-5-5" ? "gpt-6.1-sol" : "claude-opus-5-5"]);
  });

  it("the single-probe live run keeps the full pool even when a candidate's own brief fails", async () => {
    const failing: Compactor = async ({ modelId }) => {
      if (modelId.startsWith("gpt-6-astra")) throw new Error("unreachable");
      return { brief: "1) DECISIONS x", outputTokens: 300 };
    };
    const a = await runCalibration({ candidates: cfg.candidates, profiles: PROFILES, compactor: failing, reviewer: heuristicReviewer, reviewerPool: cfg.reviewerPool, reviewersPerBrief: cfg.reviewersPerBrief, groundTruth: GT, date: "2026-10-11", now: () => 0, onSkip: () => {} });
    expect(a.models).toHaveLength(6);
    for (const m of a.models) expect(m.reviewers).toContain("gpt-6-astra");
  });
});

/* ------------------------------- artifacts ------------------------------- */

describe("artifacts carry what the model decision needs and are never overwritten", () => {
  const scoreBy: Reviewer = async ({ reviewerModelId }) =>
    reviewerModelId === "gpt-6-luna" ? Promise.reject(new Error("no score")) : { recall: isClaude(reviewerModelId) ? 1 : 0.8, hallucination: 1, supersession: 1 };

  it("per-review records, actual reviewers only, reviewerEffort", async () => {
    const cfg = resolveCalibConfig({}, REAL);
    const a = await runCalibration({ candidates: cfg.candidates, profiles: PROFILES, compactor: makeFixtureCompactor(GT), reviewer: scoreBy, reviewerPool: cfg.reviewerPool, reviewersPerBrief: cfg.reviewersPerBrief, reviewerEffort: cfg.reviewerEffort, groundTruth: GT, date: "2026-10-11", now: () => 0, onSkip: () => {} });
    expect(a.reviewerEffort).toBe("high");
    const opus = a.models.find((m) => m.baseModelId === "claude-opus-5-5")!;
    // Luna was assigned but failed → not listed; 5 of 6 actually scored
    expect(opus.reviewers).not.toContain("gpt-6-luna");
    expect(opus.reviewers).toHaveLength(5);
    expect(opus.reviews).toHaveLength(5);
    for (const r of opus.reviews!) {
      expect(Object.keys(r.rubric).sort()).toEqual(["hallucination", "recall", "supersession", "verbatim"]);
      expect(r.fidelity).toBeGreaterThan(0);
    }
    const astra = opus.reviews!.find((r) => r.reviewerModelId === "gpt-6-astra")!;
    expect(astra.rubric.recall).toBe(0.8);
  });

  it("golden output: verbosity, spread, warning and reviews per probe; reviewerEffort", async () => {
    const res = await runGoldenSet({
      probes: goldenProbes(),
      candidates: ["claude-opus-5-5@high", "gpt-6.1-sol@high", "claude-haiku-5-5@high"],
      profiles: PROFILES,
      makeCompactor: (g) => makeFixtureCompactor(g),
      reviewer: heuristicReviewer,
      reviewerPool: [...CALIB_POOL],
      reviewersPerBrief: 6,
      reviewerEffort: "high",
      date: "2026-10-11",
      now: () => 0,
    });
    expect(res.reviewerEffort).toBe("high");
    for (const m of res.perModel) {
      expect(m.perProbe).toHaveLength(5);
      expect(m.meanVerbosityCoeff).toBeGreaterThan(0);
      expect(m.highSpreadWarnings).toBe(0);
      for (const p of m.perProbe) {
        expect(p.verbosityCoeff).toBeGreaterThan(0);
        expect(p.spread).toBe(0);
        expect(p.highSpreadWarning).toBe(false);
        expect(p.reviews).toHaveLength(6);
        expect(p.reviewers).not.toContain(m.baseModelId);
      }
    }
  });

  it("an existing artifact is never overwritten; mode + time are in the name", () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-artifact-"));
    try {
      const suffix = artifactSuffix(new Date("2026-10-11T14:05:09.123Z"), "real", "golden");
      expect(suffix).toBe("T14-05-09Z-real-golden");
      expect(artifactSuffix(new Date("2026-10-11T14:05:09Z"), "offline", "single")).toBe("T14-05-09Z-offline");
      const first = persistArtifact(dir, { date: "2026-10-11", run: 1 }, suffix);
      const second = persistArtifact(dir, { date: "2026-10-11", run: 2 }, suffix);
      expect(first).toBe(join(dir, "2026-10-11T14-05-09Z-real-golden.json"));
      expect(second).toBe(join(dir, "2026-10-11T14-05-09Z-real-golden-2.json"));
      expect(JSON.parse(readFileSync(first, "utf8")).run).toBe(1);
      expect(JSON.parse(readFileSync(second, "utf8")).run).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------- windows + call counts ------------------------------- */

describe("bridge windows of the pool and the high-fill (4d) configuration", () => {
  it("Claude 5.x at 1M (Claude Code), GPT-6 via Codex at the conservative 258,400; old entries kept", () => {
    for (const id of ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) expect(BRIDGE_WINDOWS[id]).toBe(1_000_000);
    for (const id of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]) expect(BRIDGE_WINDOWS[id]).toBe(258_400);
    expect(BRIDGE_WINDOWS["claude-sonnet-4-6"]).toBe(200_000);
    expect(BRIDGE_WINDOWS["gpt-5.5"]).toBe(400_000);
  });

  it("4d at 400K: the four Claude models fit, GPT-6 does not; the 800K default fits nobody", () => {
    const cfg = resolveCalibConfig({ CAIRN_CALIB_PROBE_TOKENS: "400000" }, [...REAL, "--probe", "large"]);
    expect(cfg.probeTokens).toBe(400_000);
    const tokens = estimateTokens(buildLargeProbe(cfg.probeTokens!).probe);
    const part = partitionByWindow(cfg.candidates, tokens, PROFILES, (id) => parseVariant(id).baseModelId);
    expect(part.fit.map((id) => parseVariant(id).baseModelId).sort()).toEqual(["claude-fable-5-1", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(part.excluded.map((e) => parseVariant(e.id).baseModelId).sort()).toEqual(["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"]);
    expect(partitionByWindow(cfg.candidates, 800_000, PROFILES, (id) => parseVariant(id).baseModelId).fit).toEqual([]);
  });
});

describe("dry-run call counts (the live configuration on fixtures)", () => {
  function counting(cfg: CalibConfig) {
    const calls = { compactions: 0, reviews: 0 };
    const reviewer: Reviewer = (r) => {
      calls.reviews++;
      return heuristicReviewer(r);
    };
    const compactor = (gt: typeof GT): Compactor => {
      const c = makeFixtureCompactor(gt);
      return (req) => {
        calls.compactions++;
        return c(req);
      };
    };
    return { calls, reviewer, compactor };
  }
  const opts = (cfg: CalibConfig) => ({ profiles: PROFILES, reviewerPool: cfg.reviewerPool, reviewersPerBrief: cfg.reviewersPerBrief, date: "2026-10-11", now: () => 0 });

  it("4b single probe: 7 briefs + 42 reviews = 49", async () => {
    const cfg = resolveCalibConfig({}, ["node", "cli.ts", "--dry-run"]);
    const { calls, reviewer, compactor } = counting(cfg);
    const fit = partitionByWindow(cfg.candidates, estimateTokens(loadProbeContext()), PROFILES, (id) => parseVariant(id).baseModelId).fit;
    await runCalibration({ ...opts(cfg), candidates: fit, compactor: compactor(GT), reviewer, groundTruth: GT });
    expect(calls).toEqual({ compactions: 7, reviews: 42 });
  });

  it("4c golden set: 35 briefs + 210 reviews = 245", async () => {
    const cfg = resolveCalibConfig({}, ["node", "cli.ts", "--dry-run", "--golden"]);
    const { calls, reviewer, compactor } = counting(cfg);
    await runGoldenSet({ ...opts(cfg), probes: goldenProbes(), candidates: cfg.candidates, makeCompactor: compactor, reviewer });
    expect(calls).toEqual({ compactions: 35, reviews: 210 });
  });

  it("4d high-fill at 400K: 4 Claude briefs + 24 reviews = 28", async () => {
    const cfg = resolveCalibConfig({ CAIRN_CALIB_PROBE_TOKENS: "400000" }, ["node", "cli.ts", "--dry-run", "--probe", "large"]);
    const { calls, reviewer, compactor } = counting(cfg);
    const lp = buildLargeProbe(cfg.probeTokens!);
    const fit = partitionByWindow(cfg.candidates, estimateTokens(lp.probe), PROFILES, (id) => parseVariant(id).baseModelId).fit;
    await runCalibration({ ...opts(cfg), candidates: fit, compactor: compactor(LARGE_GROUND_TRUTH), reviewer, groundTruth: LARGE_GROUND_TRUTH, probe: lp.probe, exactSpans: lp.exactSpans });
    expect(calls).toEqual({ compactions: 4, reviews: 24 });
  });
});
