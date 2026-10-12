/**
 * Cairn - calibration peer-review (ADR-0005, calibration-spec §4 & §6).
 *
 * Each brief is scored against the rubric by the strongest AVAILABLE foreign models - never
 * its own author (no self-review), blind to the author's identity. Verbatim is checked HARD
 * by string compare (not reviewer-estimated). The model reviewer is an injectable seam; the
 * offline/test reviewer (`heuristicReviewer`) is deterministic.
 */

import type { GroundTruth, GtItem } from "./ground-truth.js";

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

/** Text form the key match runs on: lower case, one space for any whitespace run (incl. no-break and
 *  thin spaces), and a decimal comma read as a point ("1,6 s" → "1.6 s"; "12.000" stays). */
export function normalizeForKeys(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/(\d),(\d{1,2})(?!\d)/g, "$1.$2");
}

const keyPatterns = new Map<string, RegExp>();
/** One key alternative as a regex: a boundary on each alphanumeric edge unless that side has `*` (see below). */
function keyPattern(key: string): RegExp {
  let re = keyPatterns.get(key);
  if (!re) {
    const open = key.startsWith("*");
    const close = key.endsWith("*");
    const core = normalizeForKeys(key.slice(open ? 1 : 0, close ? -1 : undefined));
    const esc = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lead = !open && /^[\p{L}\p{N}]/u.test(core) ? "(?<![\\p{L}\\p{N}])" : "";
    // A number ends where the key ends: no further digits ("240" is not "2400", "1.8" not "1.85") and no
    // letters ("400" is not "400k", "16" not "16GB"); a key lists the unit forms it accepts ("1.8s").
    // A word ends there too, and a URL scheme is not the word ("postgres://…" is no "postgres").
    const trail = close
      ? ""
      : /\p{N}$/u.test(core)
        ? "(?![\\p{L}\\p{N}]|[.,]\\p{N})"
        : /\p{L}$/u.test(core)
          ? "(?![\\p{L}\\p{N}]|:\\/\\/)"
          : "";
    re = new RegExp(lead + esc + trail, "u");
    keyPatterns.set(key, re);
  }
  return re;
}

/** True if every key group matches the (normalized) text by at least one alternative. */
export function matchesKeys(text: string, keys: string[][]): boolean {
  const t = normalizeForKeys(text);
  return keys.every((group) => group.some((k) => keyPattern(k).test(t)));
}

/** An `exact` item must appear byte-exact; a keyed item by its key facts; any other item as its full text,
 *  case-insensitive. */
function survives(brief: string, it: GtItem): boolean {
  if (it.exact) return brief.includes(it.text);
  if (it.keys?.length) return matchesKeys(brief, it.keys);
  return brief.toLowerCase().includes(it.text.toLowerCase());
}

export function computeRecall(brief: string, gt: GroundTruth): number {
  const items = gt.mustSurvive;
  if (!items.length) return 1;
  const hit = items.filter((it) => survives(brief, it)).length;
  return hit / items.length;
}

/** Ids of the must-survive items `computeRecall` does not find in the brief (same matching). */
export function missingMustSurvive(brief: string, gt: GroundTruth): string[] {
  return gt.mustSurvive.filter((it) => !survives(brief, it)).map((it) => it.id);
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
