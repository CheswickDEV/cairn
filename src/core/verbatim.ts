/**
 * Cairn - deterministic verbatim freeze/restore (ADR-0002, ADR-0006).
 *
 * The single HARD verbatim guarantee, model-independent. Before any model call the exact
 * spans (code fences, inline code, and caller-flagged exact values/IDs) are masked behind
 * opaque markers `[[CAIRN-HOLD-n]]`; after the call they are restored byte-exact. A marker
 * the model dropped stays dropped on purpose (judged non-essential; the full original is in
 * the store anyway). Re-implemented from the behavioral spec - no third-party code.
 */

export interface Hold {
  marker: string;
  /** The original byte-exact span this marker stands in for. */
  content: string;
}

export interface FrozenText {
  masked: string;
  holds: Hold[];
}

export const MARKER_PREFIX = "[[CAIRN-HOLD-";

/** Fenced code blocks (```...```), non-greedy. Masked first because they contain backticks. */
const FENCE_RE = /```[\s\S]*?```/g;
/** Inline code (`...`) on a single line. Runs after fences, so it never sees fence backticks. */
const INLINE_RE = /`[^`\r\n]+`/g;

/**
 * Mask exact spans behind opaque markers. `exactSpans` are literal substrings the caller
 * marked as exact (values/IDs); every occurrence of each is protected.
 */
export function freezeVerbatim(text: string, exactSpans: string[] = []): FrozenText {
  const holds: Hold[] = [];
  const mk = (content: string): string => {
    const marker = `${MARKER_PREFIX}${holds.length}]]`;
    holds.push({ marker, content });
    return marker;
  };

  // 1) fenced code blocks (largest spans first)
  let masked = text.replace(FENCE_RE, (m) => mk(m));
  // 2) inline code (markers from step 1 contain no backticks, so they are untouched)
  masked = masked.replace(INLINE_RE, (m) => mk(m));
  // 3) explicit exact spans (values/IDs); same marker reused for repeated occurrences
  for (const span of exactSpans) {
    if (!span || !masked.includes(span)) continue;
    masked = masked.split(span).join(mk(span));
  }

  return { masked, holds };
}

/** Restore byte-exact. Markers absent from `masked` (model-dropped) are simply not reinserted. */
export function restoreVerbatim(masked: string, holds: Hold[]): string {
  let out = masked;
  for (const h of holds) out = out.split(h.marker).join(h.content);
  return out;
}

/**
 * Validation helper for the handoff flow: which required exact spans are NOT byte-exact
 * present in `brief` (i.e. the host paraphrased something it must have kept verbatim).
 */
export function missingVerbatim(brief: string, required: string[]): string[] {
  return required.filter((r) => r.length > 0 && !brief.includes(r));
}
