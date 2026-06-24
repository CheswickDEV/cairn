/**
 * Cairn - calibration peer-review (ADR-0005, calibration-spec §4 & §6).
 *
 * Each brief is scored against the rubric by the strongest AVAILABLE foreign models - never
 * its own author (no self-review), blind to the author's identity. Verbatim is checked HARD
 * by string compare (not reviewer-estimated). The model reviewer is an injectable seam; the
 * offline/test reviewer (`heuristicReviewer`) is deterministic.
 */

import type { GroundTruth } from "./ground-truth.js";

/** Reviewer-judged criteria (verbatim is computed separately by string compare). */
export interface ReviewerScore {
  recall: number;
  hallucination: number; // inverted: 1 = no hallucination
  supersession: number;
}

export interface RubricScore extends ReviewerScore {
  verbatim: number;
}

export type Reviewer = (input: {
  authorModelId: string;
  reviewerModelId: string;
  brief: string;
  groundTruth: GroundTruth;
}) => Promise<ReviewerScore>;

/* --------------------------- deterministic metrics --------------------------- */

export function computeRecall(brief: string, gt: GroundTruth): number {
  const items = gt.mustSurvive;
  if (!items.length) return 1;
  const hit = items.filter((it) =>
    it.exact ? brief.includes(it.text) : brief.toLowerCase().includes(it.text.toLowerCase()),
  ).length;
  return hit / items.length;
}

/** HARD verbatim check: byte-exact presence of every `exact` must-survive item. */
export function computeVerbatimScore(brief: string, gt: GroundTruth): number {
  const exact = gt.mustSurvive.filter((it) => it.exact);
  if (!exact.length) return 1;
  return exact.filter((it) => brief.includes(it.text)).length / exact.length;
}

export function computeSupersession(brief: string, gt: GroundTruth): number {
  const sup = gt.mustSurvive.filter((it) => it.status === "superseded" || it.status === "discarded");
  if (!sup.length) return 1;
  const markers = ["superseded", "überholt", "ersetzt", "verworfen", "raus", "discarded", "veraltet", "statt"];
  const hasMarker = markers.some((m) => brief.toLowerCase().includes(m));
  const hit = sup.filter((it) => brief.toLowerCase().includes(it.text.toLowerCase()) && hasMarker).length;
  return hit / sup.length;
}

export function computeHallucination(brief: string, gt: GroundTruth): number {
  if (!gt.mustNotAppear.length) return 1;
  const hits = gt.mustNotAppear.filter((s) => brief.toLowerCase().includes(s.toLowerCase())).length;
  return 1 - hits / gt.mustNotAppear.length;
}

/** Deterministic offline reviewer: scores from the ground truth, independent of reviewer id. */
export const heuristicReviewer: Reviewer = async ({ brief, groundTruth }) => ({
  recall: computeRecall(brief, groundTruth),
  hallucination: computeHallucination(brief, groundTruth),
  supersession: computeSupersession(brief, groundTruth),
});

/**
 * Pick the >=k strongest AVAILABLE foreign models as reviewers - never the author (no
 * self-review). Cross-ecosystem is allowed here (calibration is offline; ADR-0004 untouched).
 */
export function assignReviewers(
  authorModelId: string,
  candidates: string[],
  strengthOf: (id: string) => number,
  k = 2,
): string[] {
  return candidates
    .filter((id) => id !== authorModelId)
    .sort((a, b) => strengthOf(b) - strengthOf(a))
    .slice(0, Math.max(1, k));
}
