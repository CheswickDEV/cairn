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
