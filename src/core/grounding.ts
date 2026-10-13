/**
 * Cairn - quote check for a model-written brief (ADR-0013).
 *
 * The compaction prompt puts double quotes only around exact words from the context. Where Cairn has the
 * source (sampling, bridge, API), it checks deterministically that every quote is in the source, unshortened,
 * at word boundaries; a quote it does not find is the summarizer's wording, and a note at the end of the
 * stored brief says so. Account mode has no source: the host writes the brief from the conversation, and
 * Cairn sees only the brief.
 *
 * Limits: a quote counts from three words on (single terms like "superseded" are labels, not quotes); only
 * double quotes on one line are read (`"…"`, `“…”`, `„…“`, `«…»`, `»…«`); fenced code blocks are skipped (a
 * string literal in code is no quote), inline code is read as its text, so a quote may contain it. The check
 * finds the words, not who said them or in which sense: a sentence the user rejected is in the source too,
 * and a quote may leave out words around it ("in this sprint"), except a negation right before it. A
 * paraphrase without quotes is not checked.
 */

/** A quote has at least this many words; shorter quoted spans are terms or labels. */
export const MIN_QUOTE_WORDS = 3;

/** How the note starts that Cairn appends to a stored brief for its unverified quotes (EN, DE; i18n
 *  `handoff.unverifiedNote`). A note inside a source keeps its quotes unverified (`unverifiedQuotes`). */
export const NOTE_PREFIXES = ["[Cairn check]", "[Cairn-Prüfung]"] as const;

/** A note up to the end of its line, in escaped text (a JSON string) up to a literal `\n`. What else such a
 *  line holds after the note counts as note too: its quotes are flagged rather than passed. */
const NOTE_RE = new RegExp(`(?:${NOTE_PREFIXES.map((p) => p.replace(/[[\]]/g, "\\$&")).join("|")})(?:(?!\\\\n)[^\\n])*`, "g");

/** Fenced code blocks (``` as verbatim.ts reads them, and ~~~), then inline code on one line. */
const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INLINE_RE = /`[^`\r\n]+`/g;

/** Stands in for a quote mark once its pair is read: the same length, so positions stay, and the
 *  comparison drops it. */
const PAIRED = "\u0000";

/** Quote pairs on one line, in this order: a German „…“ closes with “, the opening mark of an English “…”.
 *  A straight " opens only after a non-word character and before a non-space, and closes after a non-space
 *  and before a non-word character, so a mark inside a word or a quote left open on an earlier line pairs
 *  nothing. */
const QUOTE_RES = [
  /„([^„“”\r\n]+)[“”]/g,
  /“([^“”\r\n]+)”/g,
  /(?<![\p{L}\p{N}])"(?=\S)([^"\r\n]*?\S)"(?![\p{L}\p{N}])/gu,
  /«([^«»\r\n]+)»/g,
  /»([^«»\r\n]+)«/g,
];

const WORD = /[\p{L}\p{N}]/u;

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => WORD.test(w)).length;
}

/** The quoted spans of a brief with at least MIN_QUOTE_WORDS words, outside fenced code, in order, each
 *  once. Inline code keeps its text without the backticks, as the comparison drops them anyway. A quote
 *  inside a quote is read as well; once a pair is read, its marks pair nothing else. */
export function extractQuotes(brief: string): string[] {
  // A fence becomes a line break, so it also ends a quote.
  const text = brief.replace(FENCE_RE, "\n").replace(INLINE_RE, (code) => code.slice(1, -1));
  let rest = text;
  const found: { at: number; text: string }[] = [];
  for (const re of QUOTE_RES) {
    // Again until nothing pairs: an outer quote pairs once the marks of the quote inside it are read.
    for (let paired = true; paired; ) {
      paired = false;
      rest = rest.replace(re, (whole: string, inner: string, at: number) => {
        paired = true;
        const quote = text.slice(at + 1, at + whole.length - 1).trim();
        if (wordCount(quote) >= MIN_QUOTE_WORDS) found.push({ at, text: quote });
        return PAIRED + inner + PAIRED;
      });
    }
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((q) => q.text))];
}

/** Text form for the comparison: one kind of apostrophe (before NFKC, which splits ´), NFKC (an ellipsis
 *  becomes "...", a no-break space a space), lower case, ß as ss, no quote markers at line starts (`> `), a
 *  Markdown link as its text, dashes as a hyphen, no double quote marks, emphasis (`*`, `_`, `~`), code
 *  marks, soft hyphens or zero-width characters, one space for any whitespace run. */
export function normalizeForQuotes(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u2039\u203a\u00b4]/g, "'")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/^[ \t]*>+[ \t]?/gm, "")
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/["\u201c\u201d\u201e\u201f\u00ab\u00bb\u0000*_~`\u00ad\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** A negation word right before a match (normalized text), so a quote cannot drop it ("do not" + "switch to
 *  Postgres"). English and German, like the prompts. */
const NEGATED = "(?<!(?:^|[^\\p{L}\\p{N}'])(?:not|never|no|nor|nicht|nie|niemals|kein|keine|keinen|keinem|keiner|keines) |n't )";

/** True if the quote, normalized and without the punctuation at its edges, occurs in the normalized source
 *  as one piece, at word boundaries and not right after a negation: no omission ("…", "[…]"), no part of a
 *  longer word, no dropped "not". */
function inSource(quote: string, normalizedSource: string): boolean {
  const q = normalizeForQuotes(quote).replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
  if (!WORD.test(q)) return true;
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lead = WORD.test(q[0]) ? `(?<![\\p{L}\\p{N}])${NEGATED}` : "";
  const trail = WORD.test(q.slice(-1)) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(lead + esc + trail, "u").test(normalizedSource);
}

/**
 * The brief's quotes that are not word for word in the source. A quote that a Cairn check note in the source
 * already lists stays unverified: a resumed brief in the conversation holds both the quote and its note, and
 * the quote must not pass on its own earlier copy.
 */
export function unverifiedQuotes(brief: string, source: string): string[] {
  const noted = (source.match(NOTE_RE) ?? []).flatMap(extractQuotes).map(normalizeForQuotes);
  const normalizedSource = normalizeForQuotes(source.replace(NOTE_RE, ""));
  return extractQuotes(brief).filter((q) => {
    const n = normalizeForQuotes(q);
    return !inSource(q, normalizedSource) || noted.some((m) => m.includes(n) || n.includes(m));
  });
}
