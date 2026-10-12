/**
 * Cairn — calibration ground-truth types (ADR-0005, calibration-spec).
 *
 * Mirrors the curated scoring key shipped in `docs/calibration/ground-truth.json` (28 must_survive
 * items + 9 hallucination traps). The fixtures are loaded at runtime (see `fixtures.ts`) so the
 * canonical, version-controlled probe/key is the single source of truth — not a hand-rolled copy.
 */

export type GtKind =
  | "constraint"
  | "decision"
  | "verbatim"
  | "number"
  | "critical_context"
  | "open_decision"
  | "recency";

export type GtStatus = "accepted" | "superseded" | "discarded";

export interface GtItem {
  id: string;
  kind: GtKind;
  /** The fact/decision/value a faithful brief must carry (byte-exact when `exact`). */
  text: string;
  status?: GtStatus;
  supersedes?: string;
  supersededBy?: string;
  /** Verbatim items: presence is checked by hard byte-exact string match, never reviewer judgment. */
  exact?: boolean;
  /**
   * Key facts for the deterministic check of a non-exact item (ADR-0012): every group must match, by any
   * one of its alternatives. A brief paraphrases, so the whole `text` is rarely there verbatim; these keys
   * are the content a faithful paraphrase cannot drop (values, names, the decisive qualifier). Matching is
   * case-insensitive on word boundaries, with a decimal comma read as a point: a number ends where the key
   * ends (list unit forms such as "1.8s" as alternatives), and a word does not go on with "_" or "://". A
   * leading or trailing `*` lifts the boundary on that side; there is no `*` inside a key. Without keys the
   * whole `text` must appear (case-insensitive).
   */
  keys?: string[][];
  sourceRef?: string;
  primacy?: boolean;
  buried?: boolean;
}

export interface GroundTruth {
  mustSurvive: GtItem[];
  /** Hallucination-trap descriptions; must NOT be asserted in a brief. */
  mustNotAppear: string[];
  /** Rubric weights from the fixture (recall + hallucination weighted highest). */
  weights: { recall: number; hallucination: number; supersession: number; verbatim: number };
}
