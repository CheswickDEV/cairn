/**
 * Cairn - calibration orchestrator (ADR-0005). Pure: given candidates, the compactor and
 * reviewer seams, and a fixed date, it returns a reproducible CalibrationArtifact. Same
 * inputs → same output (no Date.now / Math.random in the result path).
 */

import type { ModelProfile } from "../core/model-profiles.js";
import { SEVEN_BUCKET_PROMPT } from "../core/prompts.js";
import { loadProbeContext, loadExactSpans, loadGroundTruth } from "./fixtures.js";
import type { GroundTruth } from "./ground-truth.js";
import { runCompactions, type Compactor } from "./runner.js";
import { parseVariant } from "./variants.js";
import { mapWithConcurrency } from "./concurrency.js";
import {
  assignReviewers,
  computeRecall,
  computeVerbatimScore,
  type Reviewer,
  type RubricScore,
} from "./review.js";
import {
  clamp01,
  median,
  stddev,
  weightedFidelity,
  SPREAD_WARN,
  type CalibrationArtifact,
  type ModelCalibration,
} from "./score.js";

export interface RunCalibrationInput {
  candidates: string[];
  profiles: ModelProfile[];
  compactor: Compactor;
  reviewer: Reviewer;
  /** ISO date stamped into the artifact (injected for reproducibility). */
  date: string;
  reviewersPerBrief?: number;
  /** Base-model ids to draw reviewers from (default: the base models behind `candidates`). */
  reviewerPool?: string[];
  /** Max parallel compactions/reviews (default 1 = serial). */
  concurrency?: number;
  /** Called when a compaction or a single review is skipped (unreachable). */
  onSkip?: (label: string, error: unknown) => void;
  probe?: string;
  prompt?: string;
  exactSpans?: string[];
  groundTruth?: GroundTruth;
  now?: () => number;
}

/** Effective strength used to rank reviewers (calibrated score if present, else provisional). */
function strengthOfFactory(profiles: ModelProfile[]): (id: string) => number {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  return (id) => {
    const p = byId.get(id);
    if (!p) return 0;
    return p.summarizer.calibrated && p.summarizer.fidelityScore != null
      ? p.summarizer.fidelityScore
      : p.summarizer.provisionalFidelity;
  };
}

export async function runCalibration(input: RunCalibrationInput): Promise<CalibrationArtifact> {
  const probe = input.probe ?? loadProbeContext();
  const prompt = input.prompt ?? SEVEN_BUCKET_PROMPT;
  const exactSpans = input.exactSpans ?? loadExactSpans();
  const gt = input.groundTruth ?? loadGroundTruth();
  const k = input.reviewersPerBrief ?? 2;
  const strengthOf = strengthOfFactory(input.profiles);

  const runs = await runCompactions({
    candidates: input.candidates,
    probe,
    prompt,
    exactSpans,
    compactor: input.compactor,
    now: input.now,
    concurrency: input.concurrency,
    onSkip: input.onSkip,
  });

  // Reviewers are BASE models (not effort variants), strongest available foreign ones - drawn only
  // from models that actually produced a real brief (so unreachable/garbage models can't review).
  const reviewerPool =
    input.reviewerPool ?? [...new Set(runs.map((r) => parseVariant(r.modelId).baseModelId))];

  const med = median(runs.map((r) => r.outputTokens));

  // Score each brief (parallel, bounded). Results stay ORDERED → deterministic artifact.
  const perRun = await mapWithConcurrency(runs, input.concurrency ?? 1, async (run) => {
    const { baseModelId, effort } = parseVariant(run.modelId);
    // No self-review even across effort tiers: exclude the author's BASE model from the pool.
    const reviewers = assignReviewers(baseModelId, reviewerPool, strengthOf, k);
    const verbatim = computeVerbatimScore(run.brief, gt);
    const perReviewerFidelity: number[] = [];
    for (const reviewerModelId of reviewers) {
      try {
        const rs = await input.reviewer({ authorModelId: run.modelId, reviewerModelId, brief: run.brief, groundTruth: gt });
        const rubric: RubricScore = { ...rs, verbatim };
        perReviewerFidelity.push(weightedFidelity(rubric));
      } catch (e) {
        input.onSkip?.(`review ${run.modelId} by ${reviewerModelId}`, e);
      }
    }

    const fidelityScore =
      perReviewerFidelity.reduce((a, b) => a + b, 0) / Math.max(1, perReviewerFidelity.length);
    const spread = stddev(perReviewerFidelity);
    const highSpreadWarning = spread > SPREAD_WARN;
    const model: ModelCalibration = {
      modelId: run.modelId,
      baseModelId,
      effort,
      fidelityScore,
      verbosityCoeff: med > 0 ? run.outputTokens / med : 1,
      confidence: clamp01(1 - spread),
      spread,
      highSpreadWarning,
      outputTokens: run.outputTokens,
      reviewers,
      retainedAllMustSurvive: computeRecall(run.brief, gt) === 1 && verbatim === 1,
    };
    const note = highSpreadWarning
      ? `⚠ ${run.modelId}: hoher Reviewer-Spread ${spread.toFixed(3)} — Warnung statt stiller Übernahme.`
      : null;
    return { model, note };
  });

  const models = perRun.map((r) => r.model);
  const notes = perRun.map((r) => r.note).filter((n): n is string => n !== null);

  const retained = models.filter((m) => m.retainedAllMustSurvive);
  const floorProposal = retained.length ? Math.min(...retained.map((m) => m.fidelityScore)) : null;

  return { date: input.date, models, floorProposal, notes };
}
