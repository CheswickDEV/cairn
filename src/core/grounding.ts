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
 * double quotes on one line are read (`"…"`, `“…”`, `„…“`, `«…»`, `»…«`), nested at most MAX_NESTING deep per kind;
 * fenced code blocks are skipped (a string literal in code is no quote), inline code is read as its text, so
 * a quote may contain it. The check finds the words, not who said them or in which sense: a sentence the user
 * rejected is in the source too, and a quote may leave out words around it ("in this sprint"), except a
 * negation right before it (or a German one right after it). A paraphrase without quotes is not checked.
 * Where a rule is in doubt it flags rather than passes; ADR-0013 lists what still passes.
 */

/** A quote has at least this many words; shorter quoted spans are terms or labels. */
export const MIN_QUOTE_WORDS = 3;

/** A longer quote counts as unverified without a search: quotes are meant to be short, and the bound keeps
 *  the check's cost in proportion to the source. */
export const MAX_QUOTE_CHARS = 1_000;

/** Runs of combining marks (and of U+FF9E/U+FF9F, which NFKC turns into ones) are cut to this many before
 *  Unicode normalization, which is quadratic on very long runs; real text has a few at most. */
const MAX_MARK_RUN = 8;
const MARK = "[\\p{M}\\uFF9E\\uFF9F]";
const MARK_RUN_RE = new RegExp(`(${MARK}{${MAX_MARK_RUN}})${MARK}+`, "gu");

/** Quotes inside quotes are read this many levels deep; each level is one more pass over the text, so the
 *  bound keeps the check linear in the input. */
export const MAX_NESTING = 3;

/** How the note starts that Cairn appends to a stored brief for its unverified quotes (EN, DE; i18n
 *  `handoff.unverifiedNote`). A note inside a source keeps its quotes unverified (`unverifiedQuotes`). */
export const NOTE_PREFIXES = ["[Cairn check]", "[Cairn-Prüfung]"] as const;

/** Any character but a line end (`\n`, `\r`, U+2028, U+2029: where the `m` flag starts a line), so a scan
 *  to the line end never runs past the next line start. */
const NOT_EOL = "[^\\n\\r\\u2028\\u2029]";
/** A note at the start of a line (after blanks or `>`), or in escaped text (a JSON string) right after a
 *  literal `\n`, up to the end of its line or the next literal `\n`; case-insensitive, also with its brackets
 *  Markdown-escaped (`\[`) and its ü JSON-escaped. A prefix inside a line is no note. */
const NOTE_PATTERNS = NOTE_PREFIXES.map((p) => p.replace(/[[\]]/g, "\\\\?\\$&").replace("ü", "(?:ü|\\\\u00fc)"));
const NOTE_RE = new RegExp(`(?:^[ \\t>]*|(?<=\\\\n))(?:${NOTE_PATTERNS.join("|")})(?:(?!\\\\n)${NOT_EOL})*`, "gim");

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
    // Again while something pairs, up to MAX_NESTING passes: an outer quote pairs once the marks of the
    // quote inside it are read.
    for (let pass = 0, paired = true; paired && pass < MAX_NESTING; pass++) {
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

/** Text form for the comparison: escapes read (`\uXXXX` as its character, `\n`, `\t`, `\r` as a space, a
 *  backslash before punctuation or a symbol dropped); runs of combining marks cut to MAX_MARK_RUN; one kind
 *  of apostrophe, and ″ as a double quote, before NFKC (which splits ´ and ″); NFKC (an ellipsis becomes
 *  "...", a no-break space a space); lower case, ß as ss; a Markdown link as its text; a hyphen, an en dash
 *  or a minus as "-" ("1–2 h", "Mo–Fr"), an em dash as " - " (it separates words: "Decision—switch"); no
 *  double quote marks, emphasis (`*`, `_`, `~~`), code marks, soft hyphens or zero-width characters; one
 *  space for any whitespace run. */
export function normalizeForQuotes(text: string): string {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(MARK_RUN_RE, "$1")
    .replace(/\\[nrt]/g, " ")
    .replace(/\\([\p{P}\p{S}])/gu, "$1")
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u2039\u203a\u00b4\u02bc]/g, "'")
    .replace(/\u2033/g, '"')
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/\[([^[\]\n]*)\]\([^()\n]*\)/g, "$1")
    .replace(/~~/g, "")
    .replace(/[\u2010-\u2013\u2212]/g, "-")
    .replace(/[\u2014\u2015]/g, " - ")
    .replace(/["\u201c\u201d\u201e\u201f\u00ab\u00bb\u0000*_`\u00ad\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** How much text around an occurrence the boundary and negation checks read. */
const WINDOW = 48;
/** Negation words, English and German like the prompts; a word ending in "n't" counts too. */
const NEGATIONS = ["not", "never", "no", "nor", "cannot", "without", "dont"].concat(
  ["nicht", "nie", "niemals", "nichts", "ohne", "kein", "keine", "keinen", "keinem", "keiner", "keines"],
);
/** Words after a negation word that make an affirmation of it ("not only", "not just", "no doubt", "without
 *  question", "nicht nur", "ohne Frage", "ohne Zweifel"). */
const AFFIRMING_WORDS = ["only", "just", "doubt", "question", "nur", "frage", "zweifel"];
const AFFIRMING = `(?:${AFFIRMING_WORDS.join("|")})(?![\\p{L}\\p{N}])`;
/** A negation word before a match, with at most one word (hyphens allowed) and then only punctuation,
 *  symbols and blanks between, so a quote cannot drop it ("do not" + "switch to Postgres", "not yet" +
 *  "deploy", "never --" + "force push"). A dash with blanks around it ends its reach: "Not Redis — we use
 *  Postgres". "no" and "kein" also flag a noun phrase after them, and the German
 *  noun "Not" reads as "not": the safe side. */
const NEGATED_BEFORE = new RegExp(
  `(?:^|[^\\p{L}\\p{N}'])(?:${NEGATIONS.join("|")}|\\p{L}+n't)` +
    // at most one word in between, not an affirming one
    `(?: (?!${AFFIRMING})[\\p{L}\\p{N}][\\p{L}\\p{N}'-]*)?` +
    // then blanks, punctuation and symbols up to the match, but no dash with blanks around it
    ` (?![\\p{P}\\p{S} ]*?(?<= )-+ )[\\p{P}\\p{S} ]*$`,
  "u",
);
/** A German negation that ends the clause right after a match ("Wir deployen am Freitag nicht.", "… auch
 *  nicht", "… nicht mehr.", "… nicht - …", "… nie (…)"). */
const NEGATED_AFTER = /^ (?:auch )?(?:nicht|nie|niemals)(?: mehr| länger)?(?:$|[.,;:!?)\]]| -| \()/u;
/** Word boundaries: a letter or digit, or one joined by a hyphen, dot or slash ("non-blocking", "22.10.1",
 *  "config/prod/app.yml"), continues the word. */
const WORD_BEFORE = /(?:[\p{L}\p{N}]|[\p{L}\p{N}][-./])$/u;
const WORD_AFTER = /^(?:[\p{L}\p{N}]|[-./][\p{L}\p{N}])/u;

/** The text without blanks and punctuation at its edges, by code point and in linear time (a regex for the
 *  end is quadratic on a long punctuation run inside the text). */
function trimEdges(text: string): string {
  const edge = /^[\s\p{P}]$/u;
  const chars = Array.from(text);
  let start = 0;
  let end = chars.length;
  while (start < end && edge.test(chars[start])) start++;
  while (end > start && edge.test(chars[end - 1])) end--;
  return chars.slice(start, end).join("");
}

/** True if the quote, normalized and without the punctuation at its edges, occurs in the normalized source
 *  as one piece, at word boundaries and with no negation dropped: no omission ("…", "[…]"), no part of a
 *  longer word. Each occurrence is checked in a window of WINDOW characters around it, so the cost stays
 *  linear in the source. */
function inSource(quote: string, normalizedSource: string): boolean {
  const q = trimEdges(normalizeForQuotes(quote));
  if (!WORD.test(q)) return true;
  for (let at = normalizedSource.indexOf(q); at !== -1; at = normalizedSource.indexOf(q, at + 1)) {
    let from = Math.max(0, at - WINDOW);
    // Never split a surrogate pair, and judge the cut on the whole character before the window.
    if (from > 0 && /[\uDC00-\uDFFF]/.test(normalizedSource[from])) from--;
    // A word cut by the window start is no word: "knot" must not read as "not".
    const window = normalizedSource.slice(from, at);
    const cut = from > 0 && /[\p{L}\p{N}']$/u.test(normalizedSource.slice(Math.max(0, from - 2), from));
    const before = cut ? window.replace(/^[\p{L}\p{N}']+/u, "") : window;
    const after = normalizedSource.slice(at + q.length, at + q.length + WINDOW);
    if (WORD_BEFORE.test(before) || WORD_AFTER.test(after)) continue;
    if (NEGATED_BEFORE.test(before) || NEGATED_AFTER.test(after)) continue;
    return true;
  }
  return false;
}

/** An item a summarizer marked as its own inference: a part of a line that ends in "(derived)", also
 *  emphasized, no source for a quote. A part ends at a line end, a literal `\n` or `\r` (escaped text) or a
 *  straight `"`, so a JSON string, a quote and the mention `"(derived)"` keep the text around them. */
const DERIVED_ITEM_RE = new RegExp(`(?:^|(?<=\\\\[nr]|"))(?:(?!\\\\[nr]|")${NOT_EOL})*\\(derived\\)[ \\t.,;*_]*(?=\\\\[nr]|"|$)`, "gim");
/** Quote markers at line starts or after a literal `\n` (`> `, `> > `), read as layout in the source; not a
 *  `>` before a number. */
const QUOTE_MARKERS_RE = /(?:^|(?<=\\n))[ \t]*(?:>(?![ \t]*\d)[ \t]?)+/gm;

/**
 * The brief's quotes that are not word for word in the source. A quote that a Cairn check note in the source
 * already lists stays unverified, and so does a quote inside or around a listed one: a resumed brief in the
 * conversation holds both the quote and its note, and the quote must not pass on its own earlier copy. An
 * item marked `(derived)` is no source either, and a quote over MAX_QUOTE_CHARS is not searched.
 */
export function unverifiedQuotes(brief: string, source: string): string[] {
  const src = source.replace(MARK_RUN_RE, "$1").normalize("NFC");
  const noted = [...new Set((src.match(NOTE_RE) ?? []).flatMap(extractQuotes).map(normalizeForQuotes))];
  const normalizedSource = normalizeForQuotes(
    src.replace(NOTE_RE, "").replace(DERIVED_ITEM_RE, "").replace(QUOTE_MARKERS_RE, ""),
  );
  return extractQuotes(brief).filter((q) => {
    const n = normalizeForQuotes(q);
    if (q.length > MAX_QUOTE_CHARS || !inSource(q, normalizedSource)) return true;
    return noted.some((m) => m.includes(n) || n.includes(m));
  });
}
