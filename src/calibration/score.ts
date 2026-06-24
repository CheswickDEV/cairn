/**
 * Cairn - calibration scoring & aggregation (ADR-0005, calibration-spec §3 & §5).
 *
 * verbosityCoeff is objective (output tokens vs the median). fidelityScore is the weighted
 * rubric mean, averaged over reviewers, with the reviewer spread written as `confidence`
 * (1 - spread). High spread raises a warning instead of being silently adopted.
 */

import type { RubricScore } from "./review.js";

/** Recall + hallucination weighted highest - those are the expensive errors (calibration-spec §4). */
export const RUBRIC_WEIGHTS = { recall: 0.4, hallucination: 0.3, supersession: 0.15, verbatim: 0.15 };
/** Above this reviewer std-dev, the score is flagged rather than silently trusted. */
export const SPREAD_WARN = 0.15;

export function weightedFidelity(r: RubricScore): number {
  return (
    r.recall * RUBRIC_WEIGHTS.recall +
    r.hallucination * RUBRIC_WEIGHTS.hallucination +
    r.supersession * RUBRIC_WEIGHTS.supersession +
    r.verbatim * RUBRIC_WEIGHTS.verbatim
  );
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Population standard deviation; 0 for <=1 sample. */
export function stddev(xs: number[]): number {
  if (xs.length <= 1) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export interface ModelCalibration {
  /** Variant id "<baseModelId>@<effort>" (== baseModelId when no effort variant). */
  modelId: string;
  baseModelId: string;
  effort: string;
  fidelityScore: number;
  verbosityCoeff: number;
  /** Reviewer agreement = clamp(1 - spread). */
  confidence: number;
  /** Std-dev of per-reviewer fidelity. */
  spread: number;
  highSpreadWarning: boolean;
  outputTokens: number;
  reviewers: string[];
  retainedAllMustSurvive: boolean;
}

export interface CalibrationArtifact {
  date: string;
  models: ModelCalibration[];
  /** Lowest fidelity among briefs that retained ALL must-survive items; null if none did. */
  floorProposal: number | null;
  notes: string[];
}
