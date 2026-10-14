import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import type { ExecFn } from "../core/bridge.js";
import { PROFILES } from "../core/model-profiles.js";
import { makeModelReviewer, parseReviewerScore, reviewerPromptSha256 } from "./model-reviewer.js";
import { runCalibration } from "./harness.js";
import { runGoldenSet, rereviewGoldenResult, goldenProbes, checkPoolInputs, type GoldenResult } from "./golden-set.js";
import { makeFixtureCompactor } from "./runner.js";
import { heuristicReviewer, type Reviewer } from "./review.js";
import { resolveCalibConfig, artifactSuffix } from "./calib-config.js";
import { loadGroundTruth } from "./fixtures.js";

/* ADR-0012: the reviewers judge hallucination against the source (the probe), list what they score as invented,
   and `--rereview` scores the stored briefs of a golden run again. Without the source anything beyond the ground
   truth read as invented. */

const GT = loadGroundTruth();
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const claudeSays = (result: string) =>
  vi.fn<ExecFn>(async () => ({ stdout: JSON.stringify({ result }), stderr: "", code: 0 }));
const SCORE = '{"recall":1,"hallucination":0.9,"supersession":1,"invented":[{"claim":"X","why":"not in the source"}]}';

describe("model reviewer with the source", () => {
  it("puts the source before the ground truth and uses the prompt that judges against it", async () => {
    const exec = claudeSays(SCORE);
    const v = await makeModelReviewer({ execFn: exec })({
      authorModelId: "gpt-6-luna@high", reviewerModelId: "claude-opus-5-5", brief: "B", groundTruth: GT, source: "SRC",
    });
    expect(v).toEqual({ recall: 1, hallucination: 0.9, supersession: 1, invented: [{ claim: "X", why: "not in the source" }] });
    const [, args, opts] = exec.mock.calls[0];
    const system = args[args.indexOf("--system-prompt") + 1];
    expect(system).toContain("gegen die QUELLE");
    // An inference that follows from the source counts the same with or without the marker: the old prompt's
    // briefs mark none, so a rule for marked ones only would favour the new prompt in a re-review.
    expect(system).toContain("ein Schluss, der aus der QUELLE folgt, ob mit (derived) markiert oder nicht");
    expect(system).toContain('"invented"');
    expect(opts.stdin!.startsWith("QUELLE:\n<<<QUELLE\nSRC\nQUELLE>>>\n\nMUST_SURVIVE:\n")).toBe(true);
    expect(opts.stdin).toContain("\nBRIEF:\nB\n");
    expect(opts.stdin).not.toContain("gpt-6-luna");
  });

  it("without the source sends the ground-truth prompt unchanged (the high-fill probe)", async () => {
    const exec = claudeSays('{"recall":1,"hallucination":1,"supersession":1}');
    const v = await makeModelReviewer({ execFn: exec })({
      authorModelId: "gpt-6-luna@high", reviewerModelId: "claude-opus-5-5", brief: "B", groundTruth: GT,
    });
    expect(v).toEqual({ recall: 1, hallucination: 1, supersession: 1 });
    const [, args, opts] = exec.mock.calls[0];
    expect(args[args.indexOf("--system-prompt") + 1]).not.toContain("QUELLE");
    expect(opts.stdin!.startsWith("MUST_SURVIVE:\n")).toBe(true);
    expect(opts.stdin).not.toContain("QUELLE");
  });

  it("codex gets system part, source and brief on stdin", async () => {
    const exec = vi.fn<ExecFn>(async () => ({
      stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: SCORE } }),
      stderr: "",
      code: 0,
    }));
    await makeModelReviewer({ execFn: exec })({
      authorModelId: "claude-opus-5-5@high", reviewerModelId: "gpt-6.1-sol", brief: "B", groundTruth: GT, source: "SRC",
    });
    const stdin = exec.mock.calls[0][2].stdin!;
    expect(stdin).toContain("gegen die QUELLE");
    expect(stdin).toContain("\n\nQUELLE:\n<<<QUELLE\nSRC\nQUELLE>>>\n\nMUST_SURVIVE:\n");
  });

  it("pins both reviewer prompts: a change needs a new review before it pools", () => {
    expect(reviewerPromptSha256(false)).not.toBe(reviewerPromptSha256(true));
    // Without the source: the prompt of every run before 2026-10-14 (those artifacts record no hash).
    expect(reviewerPromptSha256(false)).toBe("d87c8b9cc9d2712df242d7cbc2d7ac21b48e25e0b807f522d3e69d829316d28d");
    expect(reviewerPromptSha256(true)).toBe("7198a7935dc323f6a92970ecd7d4ff96f97478e62983e92f05c20bd43b748c17");
  });
});

describe("parseReviewerScore: the invented list", () => {
  it("reads {claim, why} objects and plain strings, trimmed, and drops empty entries", () => {
    const v = parseReviewerScore(
      '{"recall":1,"hallucination":0.8,"supersession":1,"invented":[{"claim":" A ","why":"w"},"B",{"claim":"C"},{},null,"",{"why":"only why"}]}',
    );
    expect(v?.invented).toEqual([
      { claim: "A", why: "w" },
      { claim: "B", why: "" },
      { claim: "C", why: "" },
      { claim: "", why: "only why" },
    ]);
  });

  it("keeps an empty list, and gives no list for a missing or malformed one", () => {
    expect(parseReviewerScore('{"recall":1,"hallucination":1,"supersession":1,"invented":[]}')?.invented).toEqual([]);
    expect(parseReviewerScore('{"recall":1,"hallucination":1,"supersession":1}')).not.toHaveProperty("invented");
    expect(parseReviewerScore('{"recall":1,"hallucination":1,"supersession":1,"invented":"none"}')).not.toHaveProperty("invented");
    expect(parseReviewerScore("Recall: 1\nHallucination: 0.9\nSupersession: 1")).not.toHaveProperty("invented");
  });

  it("caps the list at 50 entries of at most 400 characters each", () => {
    const long = "x".repeat(1000);
    const many = JSON.stringify({ recall: 1, hallucination: 0, supersession: 1, invented: Array.from({ length: 80 }, () => ({ claim: long, why: long })) });
    const v = parseReviewerScore(many)!;
    expect(v.invented).toHaveLength(50);
    expect(v.invented![0]).toEqual({ claim: "x".repeat(400), why: "x".repeat(400) });
  });
});

/** A reviewer that records what it was given and answers with fixed scores. */
function recordingReviewer(invented?: { claim: string; why: string }[]) {
  const calls: Parameters<Reviewer>[0][] = [];
  const reviewer: Reviewer = async (req) => {
    calls.push(req);
    return { recall: 1, hallucination: 0.9, supersession: 1, ...(invented ? { invented } : {}) };
  };
  return { calls, reviewer };
}

const POOL = ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6.1-sol"];
const CANDIDATES = POOL.map((id) => `${id}@high`);

describe("harness: the reviewers get the probe", () => {
  it("passes the probe as the source by default and records the invented list on the review, not in the rubric", async () => {
    const { calls, reviewer } = recordingReviewer([{ claim: "X", why: "w" }]);
    const art = await runCalibration({
      candidates: CANDIDATES, profiles: PROFILES, compactor: makeFixtureCompactor(GT), reviewer,
      reviewerPool: POOL, reviewersPerBrief: 2, date: "2026-10-14", groundTruth: GT, probe: "THE PROBE", exactSpans: [],
    });
    expect(calls).toHaveLength(6);
    for (const c of calls) expect(c.source).toBe("THE PROBE");
    for (const m of art.models) {
      for (const r of m.reviews!) {
        expect(r.invented).toEqual([{ claim: "X", why: "w" }]);
        expect(Object.keys(r.rubric).sort()).toEqual(["hallucination", "recall", "supersession", "verbatim"]);
      }
    }
  });

  it("gives no source when the run says so (high-fill probe), and no list when the reviewer gave none", async () => {
    const { calls, reviewer } = recordingReviewer();
    const art = await runCalibration({
      candidates: CANDIDATES, profiles: PROFILES, compactor: makeFixtureCompactor(GT), reviewer,
      reviewerPool: POOL, reviewersPerBrief: 2, date: "2026-10-14", groundTruth: GT, probe: "THE PROBE", exactSpans: [],
      reviewerSeesSource: false,
    });
    expect(calls).toHaveLength(6);
    for (const c of calls) expect(c).not.toHaveProperty("source");
    for (const m of art.models) for (const r of m.reviews!) expect(r).not.toHaveProperty("invented");
  });

  it("the golden set gives every brief its own probe", async () => {
    const { calls, reviewer } = recordingReviewer([]);
    const probes = goldenProbes();
    await runGoldenSet({
      probes, candidates: CANDIDATES, profiles: PROFILES, makeCompactor: (gt) => makeFixtureCompactor(gt), reviewer,
      reviewerPool: POOL, reviewersPerBrief: 2, date: "2026-10-14",
    });
    expect(calls).toHaveLength(probes.length * 6);
    for (const c of calls) {
      const gp = probes.find((p) => p.groundTruth === c.groundTruth)!;
      expect(c.source).toBe(gp.probe);
    }
  });
});

/** A golden run over the real probes on the fixture compactor and the heuristic reviewer. */
function goldenRun(): Promise<GoldenResult> {
  return runGoldenSet({
    probes: goldenProbes(), candidates: CANDIDATES, profiles: PROFILES, makeCompactor: (gt) => makeFixtureCompactor(gt),
    reviewer: heuristicReviewer, reviewerPool: POOL, reviewersPerBrief: 2, reviewerEffort: "high", date: "2026-10-12",
  });
}

describe("rereviewGoldenResult", () => {
  // A reviewer pool beyond the authors and three reviewers per brief: neither is the default.
  const REVIEWERS = [...POOL, "gpt-6-luna"];
  const rereview = (res: GoldenResult, reviewer: Reviewer) =>
    rereviewGoldenResult({ res, probes: goldenProbes(), profiles: PROFILES, reviewer, reviewerPool: REVIEWERS, reviewersPerBrief: 3, reviewerEffort: "high", date: "2026-10-14" });

  it("scores every stored brief again with the probe as the source, never by its own model, without a compaction", async () => {
    const orig = await goldenRun();
    // Distinct briefs per model, so each call can be traced back to its brief.
    orig.perModel.forEach((m) => m.perProbe.forEach((p) => { p.brief = `${m.modelId}|${p.label}|brief`; p.outputTokens = m.modelId.length * 10 + p.label.length; }));
    const { calls, reviewer } = recordingReviewer([{ claim: "X", why: "w" }]);
    const res = await rereview(orig, reviewer);
    const probes = goldenProbes();
    expect(calls).toHaveLength(probes.length * CANDIDATES.length * 3);
    for (const c of calls) {
      const [author, label] = c.brief.split("|");
      expect(c.authorModelId).toBe(author);
      expect(c.reviewerModelId).not.toBe(author.replace("@high", ""));
      const gp = probes.find((p) => p.label === label)!;
      expect(c.source).toBe(gp.probe);
      expect(c.groundTruth).toEqual(gp.groundTruth);
    }
    expect(res.probes).toEqual(orig.probes);
    expect(res.date).toBe("2026-10-14");
    expect(res.reviewerEffort).toBe("high");
    for (const m of orig.perModel) {
      const r = res.perModel.find((x) => x.modelId === m.modelId)!;
      for (const p of m.perProbe) {
        const q = r.perProbe.find((x) => x.label === p.label)!;
        expect(q.brief).toBe(p.brief);
        expect(q.outputTokens).toBe(p.outputTokens);
        // Verbosity against the probe's median of the stored output tokens, as in the run.
        const tokens = orig.perModel.map((x) => x.perProbe.find((y) => y.label === p.label)!.outputTokens).sort((u, w) => u - w);
        expect(q.verbosityCoeff).toBeCloseTo(p.outputTokens / tokens[1], 12);
        expect(q.reviews.map((v) => v.reviewerModelId).sort()).toEqual(REVIEWERS.filter((id) => `${id}@high` !== m.modelId).sort());
        for (const v of q.reviews) {
          expect(v.rubric.hallucination).toBe(0.9);
          expect(v.invented).toEqual([{ claim: "X", why: "w" }]);
        }
      }
    }
    expect(res.reviewerEffects).toBeDefined();
  });

  it("leaves out a model on a probe the run did not score it on", async () => {
    const orig = await goldenRun();
    const label = orig.probes[1];
    orig.perModel[0].perProbe = orig.perModel[0].perProbe.filter((p) => p.label !== label);
    const { calls, reviewer } = recordingReviewer();
    const res = await rereview(orig, reviewer);
    expect(calls).toHaveLength((orig.probes.length * CANDIDATES.length - 1) * 3);
    expect(res.perModel.find((m) => m.modelId === orig.perModel[0].modelId)!.perProbe.map((p) => p.label)).not.toContain(label);
  });

  it.each([
    ["a scored brief that was not stored", (r: GoldenResult) => { delete r.perModel[2].perProbe[3].brief; }, /no stored brief for gpt-6.1-sol@high on 'db-migration'/],
    ["an unknown probe", (r: GoldenResult) => { r.probes = [...r.probes, "nope"]; }, /unknown probe 'nope'/],
    ["other probe contents than recorded", (r: GoldenResult) => {
      (r as unknown as { probeInfo: unknown }).probeInfo = [{ label: "k8s-rollout", sha256: "0".repeat(64) }];
    }, /probe 'k8s-rollout' differs/],
  ] as const)("refuses %s before any review", async (_, damage, error) => {
    const orig = await goldenRun();
    damage(orig);
    const { calls, reviewer } = recordingReviewer();
    await expect(rereview(orig, reviewer)).rejects.toThrow(error);
    expect(calls).toHaveLength(0);
  });

  it("accepts recorded probe contents that match the current probes", async () => {
    const orig = await goldenRun();
    (orig as unknown as { probeInfo: unknown }).probeInfo = goldenProbes().map((p) => ({ label: p.label, sha256: sha(p.probe) }));
    const { calls, reviewer } = recordingReviewer();
    await rereview(orig, reviewer);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("checkPoolInputs: reviewer prompt and re-reviews", () => {
  const input = (path: string, sha256: string, res: GoldenResult) => ({ path, sha256, res });

  it("refuses runs scored by different reviewer prompts, also an old run without the hash beside a new one", async () => {
    const a = await goldenRun();
    const b = await goldenRun();
    b.perModel[0].perProbe[0].brief = "another brief";
    const rp = (r: GoldenResult, h?: string) => ({ ...r, ...(h ? { reviewerPromptSha256: h } : {}) }) as GoldenResult;
    for (const [x, y] of [["s", "t"], [undefined, "s"], ["s", undefined]] as const) {
      expect(() => checkPoolInputs([input("a", "1", rp(a, x)), input("b", "2", rp(b, y))])).toThrow(/^b: another reviewer prompt than a$/);
    }
    expect(() => checkPoolInputs([input("a", "1", rp(a, "s")), input("b", "2", rp(b, "s"))])).not.toThrow();
  });

  it("refuses a re-review beside the run it re-reviewed, and two re-reviews of one run", async () => {
    const orig = await goldenRun();
    const again = await rereview2(orig, 0);
    const third = await rereview2(orig, 3);
    expect(() => checkPoolInputs([input("a", "1", orig), input("b", "2", again)])).toThrow(/^b: the same briefs as a \(a re-review of the same run\)$/);
    expect(() => checkPoolInputs([input("b", "2", again), input("c", "3", third)])).toThrow(/^c: the same briefs as b/);
  });
});

/** A re-review with scores unlike the heuristic reviewer's, so its reviews differ from the original's. */
async function rereview2(res: GoldenResult, seed: number): Promise<GoldenResult> {
  let n = seed;
  const reviewer: Reviewer = async () => ({ recall: 1, hallucination: (n++ % 7) / 10, supersession: 1 });
  return rereviewGoldenResult({ res, probes: goldenProbes(), profiles: PROFILES, reviewer, reviewerPool: POOL, reviewersPerBrief: 2, date: "2026-10-14" });
}

describe("calibration config: --rereview", () => {
  const REAL = ["node", "cli.ts", "--real"];
  it("takes one golden artifact for a live or dry run, as a golden run", () => {
    const cfg = resolveCalibConfig({}, [...REAL, "--rereview", "x.json"]);
    expect(cfg.rereview).toBe("x.json");
    expect(cfg.probe).toBe("golden");
    expect(cfg.reviewersPerBrief).toBe(cfg.reviewerPool!.length - 1);
    expect(resolveCalibConfig({}, ["node", "cli.ts", "--dry-run", "--rereview", "x.json"]).rereview).toBe("x.json");
    expect(resolveCalibConfig({}, REAL)).not.toHaveProperty("rereview");
  });

  it.each([
    ["no path", [...REAL, "--rereview"], /needs the path/],
    ["a flag as the path", [...REAL, "--rereview", "--golden"], /needs the path/],
    ["two artifacts", [...REAL, "--rereview", "a.json", "--rereview", "b.json"], /one artifact per run/],
    ["offline", ["node", "cli.ts", "--rereview", "a.json"], /needs --real or --dry-run/],
    ["the high-fill probe", [...REAL, "--rereview", "a.json", "--probe", "large"], /not the high-fill probe/],
  ] as const)("refuses %s", (_, argv, error) => {
    expect(() => resolveCalibConfig({}, argv)).toThrow(error);
  });

  it("names the artifact as a re-review", () => {
    const now = new Date("2026-10-14T12:34:56Z");
    expect(artifactSuffix(now, "real", "golden", true)).toBe("T12-34-56Z-real-rereview-golden");
    expect(artifactSuffix(now, "real", "golden")).toBe("T12-34-56Z-real-golden");
  });
});
