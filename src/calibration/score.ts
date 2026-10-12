/**
 * Cairn - calibration scoring & aggregation (ADR-0005, calibration-spec §3 & §5).
 *
 * verbosityCoeff is objective (output tokens vs the median). fidelityScore is the weighted
 * rubric mean, averaged over reviewers, with the reviewer spread written as `confidence`
 * (1 - spread). High spread raises a warning instead of being silently adopted.
 */

import type { RubricScore } from "./review.js";
import type { RunProvenance } from "./provenance.js";

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
  /** Reviewers that actually scored this brief (a failed review is skipped + logged, not listed). */
  reviewers: string[];
  retainedAllMustSurvive: boolean;
  /** Ids of the must-survive items the deterministic check did not find (`missingMustSurvive`). */
  missingMustSurvive?: string[];
  /** The brief as scored, so a paid run can be checked again without rerunning it (ADR-0012). */
  brief?: string;
  /** Per-review records for the analysis (ADR-0012). Optional so hand-built records stay valid. */
  reviews?: ReviewRecord[];
}

/** One reviewer's verdict on one brief: who scored, the rubric (incl. the hard verbatim check) and the
 *  resulting weighted fidelity. */
export interface ReviewRecord {
  reviewerModelId: string;
  rubric: RubricScore;
  fidelity: number;
}

export interface CalibrationArtifact {
  date: string;
  /** Effort the reviewers ran at (live runs; ADR-0012: exactly `high`). */
  reviewerEffort?: string;
  models: ModelCalibration[];
  /** Lowest fidelity among briefs that retained ALL must-survive items; null if none did. */
  floorProposal: number | null;
  notes: string[];
  /** Code and CLI versions behind the run (set by the CLI). */
  provenance?: RunProvenance;
}

/* ------------------------------------------------------------------ */
/* Reviewer-effect correction (ADR-0012)                               */
/* ------------------------------------------------------------------ */

/** One review in the reviewer-effect fit: the brief it scored, the reviewer, the weighted fidelity. */
export interface ReviewObservation {
  brief: string;
  reviewer: string;
  fidelity: number;
}

/** Solve A·x = b (Gaussian elimination with partial pivoting); throws on a singular system. */
function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-12) throw new Error("reviewer-effect fit: singular system (reviewer design not connected)");
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/**
 * Reviewer leniency/strictness by least squares (ADR-0012): fidelity ≈ brief quality + reviewer effect, with
 * the effects centred on 0 (unweighted mean over the reviewers). In the full matrix no model reviews its own
 * brief, so each brief's mean misses exactly its author's effect; subtracting every reviewer's effect from its
 * reviews removes that. Solved exactly from the normal equations with the brief qualities eliminated:
 * (A + 11ᵀ)·e = c, where A[r][s] = n_r·[r=s] − Σ_{briefs b scored by r and s} 1/k_b and
 * c[r] = Σ_{b scored by r} (y_br − ȳ_b). A single reviewer has no relative effect (it gets 0). A design whose
 * reviewers never share a brief cannot be fitted and throws; the golden run then records why and keeps going.
 */
export function fitReviewerEffects(obs: ReviewObservation[]): Map<string, number> {
  const reviewers = [...new Set(obs.map((o) => o.reviewer))].sort();
  if (reviewers.length < 2) return new Map(reviewers.map((r) => [r, 0]));
  const idx = new Map(reviewers.map((r, i) => [r, i]));
  const byBrief = new Map<string, ReviewObservation[]>();
  for (const o of obs) byBrief.set(o.brief, [...(byBrief.get(o.brief) ?? []), o]);
  const n = reviewers.length;
  const a = Array.from({ length: n }, () => new Array<number>(n).fill(1)); // the 11ᵀ term
  const c = new Array<number>(n).fill(0);
  for (const reviews of byBrief.values()) {
    const k = reviews.length;
    const mean = reviews.reduce((s, o) => s + o.fidelity, 0) / k;
    for (const o of reviews) {
      const r = idx.get(o.reviewer)!;
      a[r][r] += 1;
      for (const p of reviews) a[r][idx.get(p.reviewer)!] -= 1 / k;
      c[r] += o.fidelity - mean;
    }
  }
  const e = solveLinear(a, c);
  return new Map(reviewers.map((r, i) => [r, e[i]]));
}
