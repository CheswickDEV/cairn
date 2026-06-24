/**
 * Cairn - calibration compaction runner (ADR-0005, calibration-spec §3).
 *
 * Every candidate compacts the SAME probe with the SAME 7-bucket prompt over the SAME
 * freezeVerbatim path. The model call is an injectable seam: real runs use the provider
 * adapters; offline runs / tests use `makeFixtureCompactor(gt)` (deterministic, no egress).
 */

import { freezeVerbatim, restoreVerbatim } from "../core/verbatim.js";
import { mapWithConcurrency } from "./concurrency.js";
import type { GroundTruth } from "./ground-truth.js";

export interface CompactionRun {
  modelId: string;
  brief: string; // verbatim-restored
  outputTokens: number;
  runtimeMs: number;
}

export interface CompactionRequest {
  modelId: string;
  /** Probe with verbatim spans already masked behind [[CAIRN-HOLD-n]] markers. */
  maskedProbe: string;
  prompt: string;
}

/** Produces a brief (may still contain freeze markers) + an output-token count. */
export type Compactor = (req: CompactionRequest) => Promise<{ brief: string; outputTokens: number }>;

/** Rough token estimate (~4 chars/token) - objective, used for verbosityCoeff. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface RunCompactionsInput {
  candidates: string[];
  probe: string;
  prompt: string;
  exactSpans?: string[];
  compactor: Compactor;
  /** Injectable clock for runtime measurement (default Date.now). */
  now?: () => number;
  /** Max parallel compactions (default 1 = serial; the live run sets higher). */
  concurrency?: number;
  /** Called when a candidate's compaction fails (unreachable model/effort) → it is skipped. */
  onSkip?: (modelId: string, error: unknown) => void;
}

export async function runCompactions(input: RunCompactionsInput): Promise<CompactionRun[]> {
  const now = input.now ?? (() => Date.now());
  const { masked, holds } = freezeVerbatim(input.probe, input.exactSpans ?? []);
  const out = await mapWithConcurrency(input.candidates, input.concurrency ?? 1, async (modelId) => {
    const t0 = now();
    try {
      const { brief, outputTokens } = await input.compactor({ modelId, maskedProbe: masked, prompt: input.prompt });
      return { modelId, brief: restoreVerbatim(brief, holds), outputTokens, runtimeMs: now() - t0 };
    } catch (e) {
      input.onSkip?.(modelId, e);
      return null;
    }
  });
  return out.filter((r): r is CompactionRun => r !== null);
}

const MARKER_RE = /\[\[CAIRN-HOLD-\d+\]\]/g;

/**
 * Deterministic offline stand-in for a real model compaction, built FROM the ground truth: every
 * non-verbatim must-survive item's text (recall), superseded/discarded items tagged (supersession),
 * and every freeze marker preserved (so the byte-exact verbatim spans round-trip). Clearly a fixture
 * - real calibration uses the provider seam; this keeps `npm run calibrate` reproducible offline.
 */
export function makeFixtureCompactor(gt: GroundTruth): Compactor {
  return async ({ maskedProbe }) => {
    const markers = [...new Set(maskedProbe.match(MARKER_RE) ?? [])];
    const facts = gt.mustSurvive
      .filter((it) => it.kind !== "verbatim")
      .map((it) => {
        const tag = it.status === "superseded" || it.status === "discarded" ? "[verworfen/superseded] " : "";
        return `- ${tag}${it.text}`;
      });
    const brief = [
      "1) DECISIONS / CONSTRAINTS / FACTS:",
      ...facts,
      "5) VERBATIM:",
      markers.join(" "),
    ].join("\n");
    return { brief, outputTokens: estimateTokens(brief) };
  };
}
