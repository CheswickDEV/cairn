import { describe, it, expect, vi } from "vitest";
import type { ExecFn } from "../core/bridge.js";
import { makeAccountCompactor } from "./account-compactor.js";
import { makeModelReviewer, parseReviewerScore } from "./model-reviewer.js";
import { bestPerBaseModel } from "./writer.js";
import { runCalibration } from "./harness.js";
import type { Compactor } from "./runner.js";
import type { Reviewer } from "./review.js";
import { loadGroundTruth } from "./fixtures.js";
import type { ModelCalibration } from "./score.js";
import { PROFILES } from "../core/model-profiles.js";

const GT = loadGroundTruth();

/* ----------------------------- account compactor ----------------------------- */

describe("makeAccountCompactor", () => {
  it("anthropic variant → claude with family alias + --effort, source on stdin", async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: JSON.stringify({ result: "1) DECISIONS x" }), stderr: "", code: 0 }));
    const c = makeAccountCompactor({ execFn: exec, minBriefTokens: 0 });
    const r = await c({ modelId: "claude-opus-4-8@xhigh", maskedProbe: "PROBE", prompt: "SYS" });
    const [cmd, args, opts] = exec.mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args[args.indexOf("--model") + 1]).toBe("opus"); // family alias, not the full id
    expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");
    expect(opts.stdin).toBe("PROBE");
    expect(r.brief).toBe("1) DECISIONS x");
  });

  it("openai variant → codex with model id + reasoning-effort config", async () => {
    const jsonl = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "1) DECISIONS y" } });
    const exec = vi.fn<ExecFn>(async () => ({ stdout: jsonl, stderr: "", code: 0 }));
    const c = makeAccountCompactor({ execFn: exec, minBriefTokens: 0 });
    const r = await c({ modelId: "gpt-5.5@high", maskedProbe: "PROBE", prompt: "SYS" });
    const [cmd, args] = exec.mock.calls[0];
    expect(cmd).toBe("codex");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.5");
    expect(args).toContain("model_reasoning_effort=high");
    expect(r.brief).toBe("1) DECISIONS y");
  });

  it("skips a too-short output (model unavailable/refused) via the min-brief gate", async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: JSON.stringify({ result: "n/a" }), stderr: "", code: 0 }));
    const c = makeAccountCompactor({ execFn: exec }); // default min 120 tokens
    await expect(c({ modelId: "gpt-5.5-pro@high", maskedProbe: "PROBE", prompt: "SYS" })).rejects.toThrow(/too short/);
  });
});

/* ------------------------------- model reviewer ------------------------------- */

describe("model reviewer", () => {
  it("parseReviewerScore extracts + clamps JSON, handles fences/prose, and returns null when absent", () => {
    expect(parseReviewerScore('blah {"recall":0.9,"hallucination":1,"supersession":0.5} tail')).toEqual({
      recall: 0.9,
      hallucination: 1,
      supersession: 0.5,
    });
    // clamps out-of-range
    expect(parseReviewerScore('{"recall":2,"hallucination":-1,"supersession":0.3}')).toEqual({
      recall: 1,
      hallucination: 0,
      supersession: 0.3,
    });
    // fenced JSON (the common failure mode)
    expect(parseReviewerScore('```json\n{"recall":0.8,"hallucination":0.9,"supersession":1}\n```')).toEqual({
      recall: 0.8,
      hallucination: 0.9,
      supersession: 1,
    });
    // prose / markdown fallback
    expect(parseReviewerScore("Recall: 0.7\nHallucination: 1.0\nSupersession: 0.6")).toEqual({
      recall: 0.7,
      hallucination: 1,
      supersession: 0.6,
    });
    // truly nothing → null (caller skips this reviewer)
    expect(parseReviewerScore("Model not available.")).toBeNull();
  });

  it("reviews a brief via a foreign model (blind), returns parsed scores", async () => {
    const exec = vi.fn<ExecFn>(async () => ({
      stdout: JSON.stringify({ result: '{"recall":0.8,"hallucination":1,"supersession":1}' }),
      stderr: "",
      code: 0,
    }));
    const reviewer = makeModelReviewer({ execFn: exec, effort: "high" });
    const score = await reviewer({ authorModelId: "gpt-5.5@high", reviewerModelId: "claude-opus-4-8", brief: "B", groundTruth: GT });
    expect(score).toEqual({ recall: 0.8, hallucination: 1, supersession: 1 });
    // reviewer ran on claude at the fixed effort, and the brief never names the author.
    const [cmd, args, opts] = exec.mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(opts.stdin).not.toContain("gpt-5.5");
  });

  it("throws (→ harness skips the reviewer) when the model returns no score JSON", async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: JSON.stringify({ result: "Model not available." }), stderr: "", code: 0 }));
    const reviewer = makeModelReviewer({ execFn: exec });
    await expect(
      reviewer({ authorModelId: "claude-opus-4-8@high", reviewerModelId: "gpt-5.5-pro", brief: "B", groundTruth: GT }),
    ).rejects.toThrow(/no parseable score/);
  });
});

/* --------------------------- best-variant-per-model --------------------------- */

describe("bestPerBaseModel (ADR-0002 fidelity-first, cost tiebreak)", () => {
  const mk = (modelId: string, baseModelId: string, fidelity: number, verbosity: number): ModelCalibration => ({
    modelId, baseModelId, effort: modelId.split("@")[1] ?? "", fidelityScore: fidelity, verbosityCoeff: verbosity,
    confidence: 1, spread: 0, highSpreadWarning: false, outputTokens: 100, reviewers: [], retainedAllMustSurvive: true,
  });

  it("picks highest fidelity per base; ties broken by lower verbosity", () => {
    const best = bestPerBaseModel([
      mk("opus@medium", "claude-opus-4-8", 0.80, 1.0),
      mk("opus@xhigh", "claude-opus-4-8", 0.92, 1.2),
      mk("opus@max", "claude-opus-4-8", 0.92, 0.9), // same fidelity, cheaper → wins the tie
      mk("gpt@high", "gpt-5.5", 0.88, 1.0),
    ]);
    expect(best.get("claude-opus-4-8")!.modelId).toBe("opus@max");
    expect(best.get("gpt-5.5")!.modelId).toBe("gpt@high");
  });
});

/* ----------------- harness with variants + cross-ecosystem + skip ----------------- */

describe("runCalibration with effort variants (injected fakes)", () => {
  const fakeCompactor: Compactor = async ({ modelId }) =>
    modelId.includes("boom") ? Promise.reject(new Error("unreachable")) : { brief: "1) DECISIONS faithful", outputTokens: 100 };
  const fakeReviewer: Reviewer = async () => ({ recall: 1, hallucination: 1, supersession: 1 });

  it("scores each (model×effort) variant, excludes the author BASE model from reviewers, skips failures", async () => {
    const candidates = ["claude-opus-4-8@high", "claude-opus-4-8@xhigh", "gpt-5.5@high", "claude-boom-9@high"];
    const skipped: string[] = [];
    const a = await runCalibration({
      candidates,
      profiles: PROFILES,
      compactor: fakeCompactor,
      reviewer: fakeReviewer,
      reviewerPool: ["claude-opus-4-8", "claude-sonnet-4-6", "gpt-5.5"],
      groundTruth: GT,
      date: "2026-06-22",
      now: () => 0,
      onSkip: (label) => skipped.push(label),
    });
    // The unreachable variant was skipped, the rest scored.
    expect(a.models.map((m) => m.modelId).sort()).toEqual(["claude-opus-4-8@high", "claude-opus-4-8@xhigh", "gpt-5.5@high"]);
    expect(skipped.some((s) => s.includes("claude-boom-9@high"))).toBe(true);
    // baseModelId/effort populated; opus variants never reviewed by opus itself.
    const opusHigh = a.models.find((m) => m.modelId === "claude-opus-4-8@high")!;
    expect(opusHigh.baseModelId).toBe("claude-opus-4-8");
    expect(opusHigh.effort).toBe("high");
    expect(opusHigh.reviewers).not.toContain("claude-opus-4-8");
    // gpt-5.5's reviewers can include the (foreign) anthropic models → cross-ecosystem.
    const gpt = a.models.find((m) => m.modelId === "gpt-5.5@high")!;
    expect(gpt.reviewers.some((r) => r.startsWith("claude-"))).toBe(true);
  });
});
