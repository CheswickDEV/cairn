/**
 * Cairn - calibration orchestrator (ADR-0005). Pure: given candidates, the compactor and
 * reviewer seams, and a fixed date, it returns a reproducible CalibrationArtifact. Same
 * inputs → same output (no Date.now / Math.random in the result path).
 */

import type { ModelProfile } from "../core/model-profiles.js";
import { SEVEN_BUCKET_PROMPT } from "../core/prompts.js";
import { loadProbeContext, loadExactSpans, loadGroundTruth } from "./fixtures.js";
import type { GroundTruth } from "./ground-truth.js";
import { runCompactions, type CompactionRun, type Compactor } from "./runner.js";
import { parseVariant } from "./variants.js";
import { mapWithConcurrency } from "./concurrency.js";
import {
  assignReviewers,
  computeRecall,
  missingMustSurvive,
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
  type ReviewRecord,
} from "./score.js";

export interface RunCalibrationInput {
  candidates: string[];
  profiles: ModelProfile[];
  compactor: Compactor;
  reviewer: Reviewer;
  /** ISO date stamped into the artifact (injected for reproducibility). */
  date: string;
  reviewersPerBrief?: number;
  /** Base-model ids to draw reviewers from (default: the base models behind `candidates`). An
   *  `@effort` suffix is stripped, so a pool entry can never review its own model's brief. */
  reviewerPool?: string[];
  /** Effort the reviewers run at; recorded in the artifact (the reviewer seam applies it). */
  reviewerEffort?: string;
  /** Max parallel compactions/reviews (default 1 = serial). */
  concurrency?: number;
  /** Called when a compaction or a single review is skipped (unreachable). */
  onSkip?: (label: string, error: unknown) => void;
  probe?: string;
  prompt?: string;
  exactSpans?: string[];
  groundTruth?: GroundTruth;
  /** Give the reviewers the probe, so they judge hallucination against it (default true, ADR-0012). The
   *  high-fill probe sets false: its reviewers see only the brief and the ground truth. */
  reviewerSeesSource?: boolean;
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

  const { models, notes } = await reviewBriefs({
    runs,
    groundTruth: gt,
    ...(input.reviewerSeesSource === false ? {} : { source: probe }),
    profiles: input.profiles,
    reviewer: input.reviewer,
    reviewerPool: input.reviewerPool,
    reviewersPerBrief: input.reviewersPerBrief,
    concurrency: input.concurrency,
    onSkip: input.onSkip,
  });

  const retained = models.filter((m) => m.retainedAllMustSurvive);
  const floorProposal = retained.length ? Math.min(...retained.map((m) => m.fidelityScore)) : null;

  return {
    date: input.date,
    ...(input.reviewerEffort ? { reviewerEffort: input.reviewerEffort } : {}),
    models,
    floorProposal,
    notes,
  };
}

export interface ReviewBriefsInput {
  /** The briefs of one probe (fresh compactions, or the stored briefs of an earlier run). */
  runs: CompactionRun[];
  groundTruth: GroundTruth;
  /** The probe, passed to every reviewer (ADR-0012); absent: the reviewers see only the ground truth. */
  source?: string;
  profiles: ModelProfile[];
  reviewer: Reviewer;
  reviewersPerBrief?: number;
  reviewerPool?: string[];
  concurrency?: number;
  onSkip?: (label: string, error: unknown) => void;
}

/**
 * Score the briefs of one probe: every brief by its reviewers (the strongest foreign pool models, never its
 * own base model), the hard verbatim check, spread and the deterministic must-survive check.
 */
export async function reviewBriefs(input: ReviewBriefsInput): Promise<{ models: ModelCalibration[]; notes: string[] }> {
  const { runs, groundTruth: gt } = input;
  const k = input.reviewersPerBrief ?? 2;
  const strengthOf = strengthOfFactory(input.profiles);

  // Reviewers are BASE models (not effort variants), strongest available foreign ones - drawn only
  // from models that actually produced a real brief (so unreachable/garbage models can't review).
  const reviewerPool = [
    ...new Set((input.reviewerPool ?? runs.map((r) => r.modelId)).map((id) => parseVariant(id).baseModelId)),
  ];

  const med = median(runs.map((r) => r.outputTokens));

  // Score each brief (parallel, bounded). Results stay ORDERED → deterministic artifact.
  const perRun = await mapWithConcurrency(runs, input.concurrency ?? 1, async (run) => {
    const { baseModelId, effort } = parseVariant(run.modelId);
    // No self-review even across effort tiers: exclude the author's BASE model from the pool.
    const reviewers = assignReviewers(baseModelId, reviewerPool, strengthOf, k);
    const verbatim = computeVerbatimScore(run.brief, gt);
    const reviews: ReviewRecord[] = [];
    for (const reviewerModelId of reviewers) {
      try {
        const { invented, ...rs } = await input.reviewer({
          authorModelId: run.modelId,
          reviewerModelId,
          brief: run.brief,
          groundTruth: gt,
          ...(input.source !== undefined ? { source: input.source } : {}),
        });
        const rubric: RubricScore = { ...rs, verbatim };
        reviews.push({ reviewerModelId, rubric, fidelity: weightedFidelity(rubric), ...(invented ? { invented } : {}) });
      } catch (e) {
        input.onSkip?.(`review ${run.modelId} by ${reviewerModelId}`, e);
      }
    }
    const perReviewerFidelity = reviews.map((r) => r.fidelity);

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
      reviewers: reviews.map((r) => r.reviewerModelId), // who actually scored, not who was assigned
      retainedAllMustSurvive: computeRecall(run.brief, gt) === 1 && verbatim === 1,
      missingMustSurvive: missingMustSurvive(run.brief, gt),
      brief: run.brief,
      reviews,
    };
    const note = highSpreadWarning
      ? `⚠ ${run.modelId}: hoher Reviewer-Spread ${spread.toFixed(3)} — Warnung statt stiller Übernahme.`
      : null;
    return { model, note };
  });

  return {
    models: perRun.map((r) => r.model),
    notes: perRun.map((r) => r.note).filter((n): n is string => n !== null),
  };
}
