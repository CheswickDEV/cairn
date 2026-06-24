/**
 * Cairn - real peer-review reviewer (ADR-0005). A foreign model scores a brief against the ground
 * truth, BLIND (no author id), returning strict JSON {recall, hallucination, supersession} ∈ 0..1.
 * Verbatim is NOT judged here (hard string match in score.ts). Reviewers run at a fixed effort for
 * consistent judgment. Uses the generic `runBridge` (no compaction directive). Injectable execFn.
 */

import { runBridge, type ExecFn } from "../core/bridge.js";
import { PROFILES } from "../core/model-profiles.js";
import { clamp01 } from "./score.js";
import { parseVariant, cliFor, cliModelName, type CalibEcosystem } from "./variants.js";
import type { Reviewer, ReviewerScore } from "./review.js";
import type { GroundTruth } from "./ground-truth.js";

const REVIEW_SYSTEM = [
  "Du bist ein strenger, neutraler Reviewer für Verdichtungs-Briefs (Compaction).",
  "Bewerte den BRIEF gegen die GROUND-TRUTH. Gib AUSSCHLIESSLICH ein JSON-Objekt aus, sonst nichts:",
  '{"recall": <0..1>, "hallucination": <0..1>, "supersession": <0..1>}',
  "- recall: Anteil der MUST_SURVIVE-Items, die inhaltlich korrekt im Brief vorkommen.",
  "- hallucination: 1.0 = nichts aus MUST_NOT_APPEAR und nichts Erfundenes; niedriger je mehr Erfundenes (invertiert).",
  "- supersession: 1.0 = überholte/verworfene Entscheidungen sind korrekt als überholt/verworfen markiert (nicht als aktuell).",
  "Antworte mit reinem JSON. Keine Tools, keine Vorrede.",
].join("\n");

function buildReviewUser(brief: string, gt: GroundTruth): string {
  const must = gt.mustSurvive.map((i) => `- (${i.kind}${i.status ? "/" + i.status : ""}) ${i.text}`).join("\n");
  const mustNot = gt.mustNotAppear.map((t) => `- ${t}`).join("\n");
  return [
    "MUST_SURVIVE:",
    must,
    "",
    "MUST_NOT_APPEAR:",
    mustNot,
    "",
    "BRIEF:",
    brief,
    "",
    'Gib jetzt das JSON {"recall","hallucination","supersession"} (je 0..1) aus.',
  ].join("\n");
}

/**
 * Extract {recall,hallucination,supersession} from a (possibly noisy) model response. Robust to
 * JSON wrapped in ```code fences``` and to prose/markdown ("Recall: 0.9 …"). Returns null only when
 * NO score signal is found - the caller then skips that reviewer rather than counting a phantom 0.
 */
export function parseReviewerScore(text: string): ReviewerScore | null {
  const num = (v: unknown) => (typeof v === "number" ? clamp01(v) : 0);
  // 1) JSON object (the brace match also handles fenced ```json {...} ```).
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as Record<string, unknown>;
      if (["recall", "hallucination", "supersession"].some((k) => typeof o[k] === "number")) {
        return { recall: num(o.recall), hallucination: num(o.hallucination), supersession: num(o.supersession) };
      }
    } catch {
      /* fall through to loose extraction */
    }
  }
  // 2) loose "key … 0.xx" extraction (prose / markdown table fallback).
  const loose = (key: string): number | null => {
    const mm = text.match(new RegExp(`${key}[^0-9]{0,15}(1(?:\\.0+)?|0(?:\\.\\d+)?)`, "i"));
    return mm ? clamp01(parseFloat(mm[1])) : null;
  };
  const r = loose("recall");
  const h = loose("hallucination");
  const s = loose("supersession");
  if (r !== null || h !== null || s !== null) {
    return { recall: r ?? 0, hallucination: h ?? 0, supersession: s ?? 0 };
  }
  return null;
}

export interface ModelReviewerOptions {
  execFn?: ExecFn;
  timeoutMs?: number;
  /** Fixed reviewer effort for consistent judgment (default "high"). */
  effort?: string;
}

export function makeModelReviewer(opts: ModelReviewerOptions = {}): Reviewer {
  return async ({ reviewerModelId, brief, groundTruth }) => {
    const { baseModelId } = parseVariant(reviewerModelId);
    const profile = PROFILES.find((p) => p.id === baseModelId);
    if (!profile || (profile.ecosystem !== "anthropic" && profile.ecosystem !== "openai")) {
      throw new Error(`reviewer '${reviewerModelId}': no bridgeable ecosystem`);
    }
    const ecosystem = profile.ecosystem as CalibEcosystem;
    const r = await runBridge({
      cli: cliFor(ecosystem),
      system: REVIEW_SYSTEM,
      user: buildReviewUser(brief, groundTruth),
      model: cliModelName(baseModelId, ecosystem),
      effort: opts.effort ?? "high",
      execFn: opts.execFn,
      timeoutMs: opts.timeoutMs,
    });
    // A reviewer with no parseable score (e.g. an unavailable model's stub or a refusal) must be
    // SKIPPED, not counted as a 0 - otherwise broken reviewers inflate the spread of every brief.
    const score = parseReviewerScore(r.text);
    if (!score) throw new Error(`reviewer '${baseModelId}' returned no parseable score`);
    return score;
  };
}
