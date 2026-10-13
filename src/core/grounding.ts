/**
 * Cairn - quote check for a model-written brief (ADR-0013).
 *
 * The compaction prompt puts a person's own words in double quotes and nothing else. Where Cairn has the
 * source (sampling, bridge, API), it checks deterministically that every quote is in the source; a quote it
 * does not find is the summarizer's wording, so the stored brief marks it as derived. Account mode has no
 * source: the host writes the brief from the conversation, and Cairn sees only the brief.
 *
 * Limits: a quote counts from three words on (single terms like "superseded" are labels, not quotes); only
 * double quotes on one line are read (`"…"`, `“…”`, `„…“`, `«…»`, `»…«`); fenced code blocks are skipped (a
 * string literal in code is no quote), inline code is read as its text, so a quote may contain it. A
 * paraphrase without quotes is not checked: the check makes quotes trustworthy, it does not find every
 * invention.
 */

/** A quote has at least this many words; shorter quoted spans are terms or labels. */
export const MIN_QUOTE_WORDS = 3;

/** Code spans as verbatim.ts reads them: fenced blocks first, then inline code on one line. */
const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_RE = /`[^`\r\n]+`/g;

/** Quote pairs on one line, in this order: a German „…“ closes with “, the opening mark of an English “…”.
 *  A straight " opens only after a non-word character and before a non-space, and closes after a non-space
 *  and before a non-word character, so an inch mark or a quote left open on an earlier line pairs nothing. */
const QUOTE_RES = [
  /„([^„“”\n]+)[“”]/g,
  /“([^“”\n]+)”/g,
  /(?<![\p{L}\p{N}])"(?=\S)([^"\n]*?\S)"(?![\p{L}\p{N}])/gu,
  /«([^«»\n]+)»/g,
  /»([^«»\n]+)«/g,
];

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** The quoted spans of a brief with at least MIN_QUOTE_WORDS words, outside fenced code, in order, each
 *  once. Inline code keeps its text without the backticks, as the comparison drops them anyway. */
export function extractQuotes(brief: string): string[] {
  let rest = brief.replace(FENCE_RE, " ").replace(INLINE_RE, (code) => code.slice(1, -1));
  const found: { at: number; text: string }[] = [];
  for (const re of QUOTE_RES) {
    rest = rest.replace(re, (whole: string, inner: string, at: number) => {
      const text = inner.trim();
      if (wordCount(text) >= MIN_QUOTE_WORDS) found.push({ at, text });
      // Blank the pair, same length, so a later pattern neither pairs across it nor shifts positions.
      return " ".repeat(whole.length);
    });
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((q) => q.text))];
}

/** Text form for the comparison: NFKC (an ellipsis becomes "...", a no-break space a space), lower case,
 *  one kind of apostrophe and double quote, no emphasis or code marks, one space for any whitespace run. */
export function normalizeForQuotes(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[*`]/g, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** True if the quote is in the normalized source: each part between an ellipsis or a bracketed insertion
 *  ("[…]"), without the punctuation at its edges. */
function inSource(quote: string, normalizedSource: string): boolean {
  return normalizeForQuotes(quote)
    .split(/\.{3}|\[[^\]]*\]/)
    .map((part) => part.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, ""))
    .filter((part) => /[\p{L}\p{N}]/u.test(part))
    .every((part) => normalizedSource.includes(part));
}

/** The brief's quotes that are not word for word in the source. */
export function unverifiedQuotes(brief: string, source: string): string[] {
  const normalizedSource = normalizeForQuotes(source);
  return extractQuotes(brief).filter((q) => !inSource(q, normalizedSource));
}
