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
 * negation right before it (or a German one right after it) that the brief does not repeat in the source's
 * words right outside the quote marks. A paraphrase without quotes is not checked.
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

/** One quote of a brief: its text, and where its opening mark is and its closing mark ends in `text`, the
 *  brief as read (fences as line breaks, inline code as its text). */
interface QuoteSpan {
  text: string;
  at: number;
  end: number;
}

/** Every quote of a brief with at least MIN_QUOTE_WORDS words, outside fenced code, in brief order. A quote
 *  inside a quote is read as well; once a pair is read, its marks pair nothing else. */
function quoteSpans(brief: string): { text: string; spans: QuoteSpan[] } {
  // A fence becomes a line break, so it also ends a quote.
  const text = brief.replace(FENCE_RE, "\n").replace(INLINE_RE, (code) => code.slice(1, -1));
  let rest = text;
  const spans: QuoteSpan[] = [];
  for (const re of QUOTE_RES) {
    // Again while something pairs, up to MAX_NESTING passes: an outer quote pairs once the marks of the
    // quote inside it are read.
    for (let pass = 0, paired = true; paired && pass < MAX_NESTING; pass++) {
      paired = false;
      rest = rest.replace(re, (whole: string, inner: string, at: number) => {
        paired = true;
        const quote = text.slice(at + 1, at + whole.length - 1).trim();
        if (wordCount(quote) >= MIN_QUOTE_WORDS) spans.push({ text: quote, at, end: at + whole.length });
        return PAIRED + inner + PAIRED;
      });
    }
  }
  return { text, spans: spans.sort((a, b) => a.at - b.at) };
}

/** The quoted spans of a brief with at least MIN_QUOTE_WORDS words, outside fenced code, in order, each
 *  once. Inline code keeps its text without the backticks, as the comparison drops them anyway. A quote
 *  inside a quote is read as well; once a pair is read, its marks pair nothing else. */
export function extractQuotes(brief: string): string[] {
  return [...new Set(quoteSpans(brief).spans.map((q) => q.text))];
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
 *  noun "Not" reads as "not": the safe side. The group holds the text from the negation word on. */
const NEGATED_BEFORE = new RegExp(
  `(?:^|[^\\p{L}\\p{N}'])((?:${NEGATIONS.join("|")}|\\p{L}+n't)` +
    // at most one word in between, not an affirming one
    `(?: (?!${AFFIRMING})[\\p{L}\\p{N}][\\p{L}\\p{N}'-]*)?` +
    // then blanks, punctuation and symbols up to the match, but no dash with blanks around it
    ` (?![\\p{P}\\p{S} ]*?(?<= )-+ )[\\p{P}\\p{S} ]*)$`,
  "u",
);
/** A German negation that ends the clause right after a match ("Wir deployen am Freitag nicht.", "… auch
 *  nicht", "… nicht mehr.", "… nicht - …", "… nie (…)"); the group holds its words. */
const NEGATED_AFTER = /^( (?:auch )?(?:nicht|nie|niemals)(?: mehr| länger)?)(?:$|[.,;:!?)\]]| -| \()/u;
/** A negation word as a whole word; the group holds the word. */
const NEGATION_WORD = new RegExp(`(?:^|[^\\p{L}\\p{N}'])((?:${NEGATIONS.join("|")}|\\p{L}+n't)(?![\\p{L}\\p{N}']))`, "u");
/** All negation words, for the last one of a clause. */
const NEGATION_WORDS = new RegExp(NEGATION_WORD.source, "gu");
/** The end of a sentence or clause in normalized text: `.`, `!`, `?`, `;` or `:` before a blank or the end, but
 *  not a dot after a one-letter word ("e.g.", "z.B."). A dash is no end: it often sets off an aside
 *  ("Never - not even on Fridays - merge without"). */
const CLAUSE_END = /(?<!(?:^|[^\p{L}])\p{L})\.(?= |$)|[!?;:](?= |$)/gu;
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

/** The `width` characters of normalized text before `at`, without a word the window start cuts: "knot" must
 *  not read as "not". */
function windowBefore(normalized: string, at: number, width = WINDOW): string {
  let from = Math.max(0, at - width);
  // Never split a surrogate pair, and judge the cut on the whole character before the window.
  if (from > 0 && /[\uDC00-\uDFFF]/.test(normalized[from])) from--;
  const window = normalized.slice(from, at);
  const cut = from > 0 && /[\p{L}\p{N}']$/u.test(normalized.slice(Math.max(0, from - 2), from));
  return cut ? window.replace(/^[\p{L}\p{N}']+/u, "") : window;
}

/** How far the words of an occurrence's clause are read each way, for what the brief must keep. */
const CLAUSE_WINDOW = 4 * WINDOW;
/** Characters of the brief read beside a quote's marks: normalization can shorten them, and what the brief
 *  must keep is at most CLAUSE_WINDOW characters. */
const BRIEF_CONTEXT = 2 * CLAUSE_WINDOW;
const LINE_BREAK = /[\n\r\u2028\u2029]/;
const EDGE = /[\p{P}\p{S}\s]/u;

/** The text without punctuation, symbols and blanks at its end (`end`) or start, by code point and in linear
 *  time. */
function trimSide(text: string, side: "start" | "end"): string {
  const chars = Array.from(text);
  let from = 0;
  let to = chars.length;
  if (side === "start") while (from < to && EDGE.test(chars[from])) from++;
  else while (to > from && EDGE.test(chars[to - 1])) to--;
  return chars.slice(from, to).join("");
}

/** What a negated occurrence in the source asks the brief to keep right outside the quote marks: the negation
 *  words of its clause in the source's own words, from the clause's first negation word up to the occurrence
 *  (`before`) and from the occurrence up to the clause's last negation word (`after`), each without the
 *  punctuation beside the quote; "" where the clause has none on that side. */
interface Needs {
  before: string;
  after: string;
}

/** What the brief must keep is taken from at most this many negated occurrences of a quote, so the cost per
 *  occurrence stays that of the plain check; a later negated occurrence counts as not found (the safe side). */
export const MAX_NEEDS = 16;

/** What an occurrence at `at`..`end` needs the brief to keep, or null if no negation is beside it (by the rules
 *  on the WINDOW characters `before` and `after`). */
function needOf(src: string, at: number, end: number, before: string, after: string): Needs | null {
  const negatedBefore = NEGATED_BEFORE.exec(before);
  const negatedAfter = NEGATED_AFTER.exec(after);
  if (!negatedBefore && !negatedAfter) return null;
  // The clause before the occurrence: from its first negation word, or at least from the negation found.
  const wide = windowBefore(src, at, CLAUSE_WINDOW);
  let clauseStart = 0;
  for (const m of wide.matchAll(CLAUSE_END)) clauseStart = m.index + m[0].length;
  let from = negatedBefore ? wide.length - negatedBefore[1].length : wide.length;
  const first = clauseStart < from ? NEGATION_WORD.exec(wide.slice(clauseStart, from)) : null;
  if (first) from = clauseStart + first.index + first[0].length - first[1].length;
  // The clause after it: up to its last negation word, or at least the German clause-final negation found.
  const rest = src.slice(end, end + CLAUSE_WINDOW);
  const clauseEnd = rest.search(CLAUSE_END);
  let to = negatedAfter ? negatedAfter[1].length : 0;
  for (const m of (clauseEnd === -1 ? rest : rest.slice(0, clauseEnd)).matchAll(NEGATION_WORDS)) to = Math.max(to, m.index + m[0].length);
  return { before: trimSide(wide.slice(from), "end"), after: trimSide(rest.slice(0, to), "start") };
}

/** The source's occurrences of a quote (normalized, without the punctuation at its edges) in one piece and
 *  at word boundaries: `free` if one has no negation beside it, else what the brief must keep for one of
 *  them to count. No omission ("…", "[…]") and no part of a longer word passes. Each occurrence is judged in
 *  a window of WINDOW characters around it, a negated one also on its clause, so the cost stays linear in the
 *  source. */
function occurrences(q: string, normalizedSource: string): { free: boolean; needs: Needs[] } {
  if (!WORD.test(q)) return { free: true, needs: [] };
  const needs = new Map<string, Needs>();
  let negated = 0;
  for (let at = normalizedSource.indexOf(q); at !== -1; at = normalizedSource.indexOf(q, at + 1)) {
    const before = windowBefore(normalizedSource, at);
    const after = normalizedSource.slice(at + q.length, at + q.length + WINDOW);
    if (WORD_BEFORE.test(before) || WORD_AFTER.test(after)) continue;
    if (negated >= MAX_NEEDS) {
      // Past the first MAX_NEEDS negated occurrences only one without a negation still counts.
      if (!NEGATED_BEFORE.test(before) && !NEGATED_AFTER.test(after)) return { free: true, needs: [] };
      continue;
    }
    const need = needOf(normalizedSource, at, at + q.length, before, after);
    if (!need) return { free: true, needs: [] };
    negated++;
    needs.set(JSON.stringify([need.before, need.after]), need);
  }
  return { free: false, needs: [...needs.values()] };
}

/** The brief's text beside a quote's marks, on the quote's line, normalized and without the punctuation and
 *  blanks next to the marks: what stands before the opening mark and after the closing mark. */
function briefContext(text: string, span: QuoteSpan): Needs {
  const from = Math.max(0, span.at - BRIEF_CONTEXT);
  const head = text.slice(from, span.at).split(LINE_BREAK);
  // A word the slice start (or end) cuts is dropped, unless a line break bounds the slice.
  const prefix = normalizeForQuotes(head.length === 1 && from > 0 ? head[0].replace(/^\S*/u, "") : head[head.length - 1]);
  const to = Math.min(text.length, span.end + BRIEF_CONTEXT);
  const tail = text.slice(span.end, to).split(LINE_BREAK);
  const suffix = normalizeForQuotes(tail.length === 1 && to < text.length ? tail[0].replace(/\S*$/u, "") : tail[0]);
  return { before: trimSide(prefix, "end"), after: trimSide(suffix, "start") };
}

/** Whether the brief keeps what an occurrence needs, as whole words: its text before the quote ends in the
 *  source's negation words (`kein "Write-Lock > 1 s"` for `kein **Write-Lock > 1 s**`), and its text after
 *  the quote starts with them (`Ohne "Review" mergen wir nicht`). */
function keeps(brief: Needs, need: Needs): boolean {
  if (need.before) {
    const start = brief.before.length - need.before.length;
    if (!brief.before.endsWith(need.before)) return false;
    if (start > 0 && /[\p{L}\p{N}']$/u.test(brief.before.slice(Math.max(0, start - 2), start))) return false;
  }
  if (need.after) {
    if (!brief.after.startsWith(need.after)) return false;
    if (/^[\p{L}\p{N}']/u.test(brief.after.slice(need.after.length))) return false;
  }
  return true;
}

/** How long a remark inside the marker may be: "(derived: not confirmed)". */
export const MAX_DERIVED_REMARK = 80;
/** The marker "(derived)", or with a remark after a colon, on one line, without parentheses, a straight `"`
 *  or a backslash in it. A remark after a blank is no marker: "(derived class)", "(derived from the JWT)"
 *  are ordinary words. */
const DERIVED_MARK = `\\(derived(?::(?:(?![()"\\\\])${NOT_EOL}){0,${MAX_DERIVED_REMARK}})?\\)`;
/** An item a summarizer marked as its own inference: a part of a line that ends in the marker, also
 *  emphasized, no source for a quote. A part ends at a line end, a literal `\n` or `\r` (escaped text) or a
 *  straight `"`, so a JSON string, a quote and the mention `"(derived)"` keep the text around them. */
const DERIVED_ITEM_RE = new RegExp(`(?:^|(?<=\\\\[nr]|"))(?:(?!\\\\[nr]|")${NOT_EOL})*${DERIVED_MARK}[ \\t.,;*_]*(?=\\\\[nr]|"|$)`, "gim");
/** Quote markers at line starts or after a literal `\n` (`> `, `> > `), read as layout in the source; not a
 *  `>` before a number. */
const QUOTE_MARKERS_RE = /(?:^|(?<=\\n))[ \t]*(?:>(?![ \t]*\d)[ \t]?)+/gm;

/**
 * The brief's quotes that are not word for word in the source. A quote that a Cairn check note in the source
 * already lists stays unverified, and so does a quote inside or around a listed one: a resumed brief in the
 * conversation holds both the quote and its note, and the quote must not pass on its own earlier copy. An
 * item marked `(derived)` is no source either, and a quote over MAX_QUOTE_CHARS is not searched. Where the
 * source has a negation beside the quote, the brief must keep its words right outside the quote marks
 * (`keeps`). A quote the brief repeats is judged at each place, as what stands beside it may differ; it is
 * listed once.
 */
export function unverifiedQuotes(brief: string, source: string): string[] {
  const src = source.replace(MARK_RUN_RE, "$1").normalize("NFC");
  const noted = [...new Set((src.match(NOTE_RE) ?? []).flatMap(extractQuotes).map(normalizeForQuotes))];
  const normalizedSource = normalizeForQuotes(
    src.replace(NOTE_RE, "").replace(DERIVED_ITEM_RE, "").replace(QUOTE_MARKERS_RE, ""),
  );
  const { text, spans } = quoteSpans(brief);
  // Each quote's compared form (null if it cannot pass), and the source searched once per form, however
  // often and in whatever spelling the brief has it.
  const compared = new Map<string, string | null>();
  const searched = new Map<string, { free: boolean; needs: Needs[] }>();
  const unverified = new Set<string>();
  for (const span of spans) {
    const q = span.text;
    if (unverified.has(q)) continue;
    let key = compared.get(q);
    if (key === undefined) {
      const n = normalizeForQuotes(q);
      key = q.length > MAX_QUOTE_CHARS || noted.some((m) => m.includes(n) || n.includes(m)) ? null : trimEdges(n);
      compared.set(q, key);
    }
    if (key === null) {
      unverified.add(q);
      continue;
    }
    let found = searched.get(key);
    if (!found) searched.set(key, (found = occurrences(key, normalizedSource)));
    if (found.free) continue;
    const kept = briefContext(text, span);
    if (!found.needs.some((need) => keeps(kept, need))) unverified.add(q);
  }
  return [...new Set(spans.map((s) => s.text))].filter((q) => unverified.has(q));
}
