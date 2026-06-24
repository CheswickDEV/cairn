/**
 * Cairn - multi-probe golden set (ADR-0005). Running each candidate over SEVERAL probes and
 * averaging the fidelity reduces single-probe / single-reviewer noise: a more robust score than
 * one probe. Returns the per-model mean plus the per-probe breakdown.
 */

import type { ModelProfile } from "../core/model-profiles.js";
import type { GroundTruth } from "./ground-truth.js";
import type { Compactor } from "./runner.js";
import type { Reviewer } from "./review.js";
import { runCalibration } from "./harness.js";
import { median } from "./score.js";
import { loadProbeContext, loadGroundTruth, loadExactSpans } from "./fixtures.js";
import { GOLDEN2_PROBE, GOLDEN2_GROUND_TRUTH, GOLDEN2_EXACT_SPANS } from "./golden-probe-2.js";
import { GOLDEN3_PROBE, GOLDEN3_GROUND_TRUTH, GOLDEN3_EXACT_SPANS } from "./golden-probe-3.js";
import { GOLDEN4_PROBE, GOLDEN4_GROUND_TRUTH, GOLDEN4_EXACT_SPANS } from "./golden-probe-4.js";
import { GOLDEN5_PROBE, GOLDEN5_GROUND_TRUTH, GOLDEN5_EXACT_SPANS } from "./golden-probe-5.js";

export interface GoldenProbe {
  label: string;
  probe: string;
  groundTruth: GroundTruth;
  exactSpans: string[];
}

/** The default golden set: five distinct domains. Averaging fidelity over all of them is far less
 *  noisy than a single probe. Add more here to grow it. */
export function goldenProbes(): GoldenProbe[] {
  return [
    { label: "ocr-beleg", probe: loadProbeContext(), groundTruth: loadGroundTruth(), exactSpans: loadExactSpans() },
    { label: "api-gateway", probe: GOLDEN2_PROBE, groundTruth: GOLDEN2_GROUND_TRUTH, exactSpans: GOLDEN2_EXACT_SPANS },
    { label: "oauth-token", probe: GOLDEN3_PROBE, groundTruth: GOLDEN3_GROUND_TRUTH, exactSpans: GOLDEN3_EXACT_SPANS },
    { label: "db-migration", probe: GOLDEN4_PROBE, groundTruth: GOLDEN4_GROUND_TRUTH, exactSpans: GOLDEN4_EXACT_SPANS },
    { label: "k8s-rollout", probe: GOLDEN5_PROBE, groundTruth: GOLDEN5_GROUND_TRUTH, exactSpans: GOLDEN5_EXACT_SPANS },
  ];
}

export interface GoldenModelResult {
  modelId: string;
  baseModelId: string;
  effort: string;
  meanFidelity: number;
  meanConfidence: number;
  probesScored: number;
  perProbe: { label: string; fidelity: number; confidence: number }[];
}

export interface GoldenResult {
  date: string;
  probes: string[];
  perModel: GoldenModelResult[];
  floorProposal: number | null;
}

export interface RunGoldenSetInput {
  probes: GoldenProbe[];
  candidates: string[];
  profiles: ModelProfile[];
  /** Per-probe compactor (offline: makeFixtureCompactor(gt); real: a gt-agnostic account compactor). */
  makeCompactor: (gt: GroundTruth) => Compactor;
  reviewer: Reviewer;
  reviewerPool?: string[];
  reviewersPerBrief?: number;
  concurrency?: number;
  date: string;
  now?: () => number;
  onSkip?: (label: string, error: unknown) => void;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export async function runGoldenSet(input: RunGoldenSetInput): Promise<GoldenResult> {
  const byVariant = new Map<string, GoldenModelResult>();

  for (const gp of input.probes) {
    const art = await runCalibration({
      candidates: input.candidates,
      profiles: input.profiles,
      compactor: input.makeCompactor(gp.groundTruth),
      reviewer: input.reviewer,
      reviewerPool: input.reviewerPool,
      reviewersPerBrief: input.reviewersPerBrief,
      concurrency: input.concurrency,
      date: input.date,
      now: input.now,
      groundTruth: gp.groundTruth,
      probe: gp.probe,
      exactSpans: gp.exactSpans,
      onSkip: input.onSkip,
    });
    for (const m of art.models) {
      const e =
        byVariant.get(m.modelId) ??
        { modelId: m.modelId, baseModelId: m.baseModelId, effort: m.effort, meanFidelity: 0, meanConfidence: 0, probesScored: 0, perProbe: [] };
      e.perProbe.push({ label: gp.label, fidelity: m.fidelityScore, confidence: m.confidence });
      byVariant.set(m.modelId, e);
    }
  }

  const perModel = [...byVariant.values()].map((e) => ({
    ...e,
    meanFidelity: mean(e.perProbe.map((p) => p.fidelity)),
    meanConfidence: mean(e.perProbe.map((p) => p.confidence)),
    probesScored: e.perProbe.length,
  }));

  // Floor proposal: the median mean-fidelity across models (robust central value), or null if empty.
  const floorProposal = perModel.length ? median(perModel.map((m) => m.meanFidelity)) : null;

  return { date: input.date, probes: input.probes.map((p) => p.label), perModel, floorProposal };
}
