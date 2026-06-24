/**
 * Cairn — loads the canonical calibration fixtures from `docs/calibration/` (ADR-0005).
 *
 * The version-controlled probe-context.md + ground-truth.json are the single source of truth (the
 * same basis every model sees). Read at runtime so calibration never drifts from the committed key.
 * (docs/ ships with the package via package.json `files`.)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GroundTruth, GtItem, GtKind, GtStatus } from "./ground-truth.js";

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../docs/calibration/${name}`, import.meta.url));
}

function canonicalNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function loadProbeContext(): string {
  return canonicalNewlines(readFileSync(fixturePath("probe-context.md"), "utf8"));
}

interface RawItem {
  id: string;
  kind: string;
  text: string;
  status?: string;
  supersedes?: string;
  superseded_by?: string;
  exact?: boolean;
  source_ref?: string;
  primacy?: boolean;
  buried?: boolean;
}
interface RawGroundTruth {
  must_survive: RawItem[];
  must_not_appear: Array<{ id: string; text: string; why?: string }>;
  scoring: { weights: GroundTruth["weights"] };
}

export function loadGroundTruth(): GroundTruth {
  const raw = JSON.parse(readFileSync(fixturePath("ground-truth.json"), "utf8")) as RawGroundTruth;
  const mustSurvive: GtItem[] = raw.must_survive.map((r) => ({
    id: r.id,
    kind: r.kind as GtKind,
    text: canonicalNewlines(r.text),
    status: r.status as GtStatus | undefined,
    supersedes: r.supersedes,
    supersededBy: r.superseded_by,
    exact: r.exact,
    sourceRef: r.source_ref,
    primacy: r.primacy,
    buried: r.buried,
  }));
  return {
    mustSurvive,
    mustNotAppear: raw.must_not_appear.map((m) => canonicalNewlines(m.text)),
    weights: raw.scoring.weights,
  };
}

/** Exact spans to freeze before compaction = the verbatim must-survive items. */
export function loadExactSpans(): string[] {
  return loadGroundTruth()
    .mustSurvive.filter((i) => i.exact && i.text.length > 0)
    .map((i) => i.text);
}
