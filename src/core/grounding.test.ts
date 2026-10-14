import { describe, it, expect } from "vitest";
import { extractQuotes, normalizeForQuotes, unverifiedQuotes, MIN_QUOTE_WORDS, MAX_NESTING, MAX_QUOTE_CHARS, NOTE_PREFIXES } from "./grounding.js";
import { t } from "../i18n/index.js";

/** Invisible or look-alike characters by code point, so the test file holds none as literals. */
const ch = (...codes: number[]) => String.fromCharCode(...codes);
const NBSP = ch(0xa0), SHY = ch(0xad), ZWSP = ch(0x200b), BOM = ch(0xfeff), MOD_APOS = ch(0x2bc), DIAERESIS = ch(0x308);
/** A JSON \\u escape as text (backslash, "u", four hex digits). */
const esc = (code: number) => "\\" + "u" + code.toString(16).padStart(4, "0");

describe("extractQuotes", () => {
  it("reads straight, English, German and both guillemet quotes, in brief order", () => {
    const brief = [
      'A: "one two three" then “four five six”.',
      "B: „sieben acht neun“ und «ten eleven twelve» und »dreizehn vierzehn fünfzehn«.",
    ].join("\n");
    expect(extractQuotes(brief)).toEqual([
      "one two three",
      "four five six",
      "sieben acht neun",
      "ten eleven twelve",
      "dreizehn vierzehn fünfzehn",
    ]);
  });

  it("does not pair a German closing mark with a later English closing mark", () => {
    expect(extractQuotes("„eins zwei drei“ und dann “vier fünf sechs”")).toEqual(["eins zwei drei", "vier fünf sechs"]);
    // A German quote may also close with ” (common in typeset text).
    expect(extractQuotes("„eins zwei drei” und “vier fünf sechs”")).toEqual(["eins zwei drei", "vier fünf sechs"]);
  });

  it(`needs at least ${MIN_QUOTE_WORDS} words: shorter quoted spans are labels`, () => {
    expect(extractQuotes('mark it "superseded", write "no Postgres", but "do not switch"')).toEqual(["do not switch"]);
    // Words need a letter or digit: dashes and arrows do not count.
    expect(extractQuotes('"a — b"')).toEqual([]);
  });

  it("skips fenced code (``` and ~~~) and reads inline code as its text, so a quote may contain it", () => {
    const brief = ['Use `db.pragma("journal_mode = WAL")` here.', "```ts", 'log("this is code text");', "```", '"a real quote here"'].join("\n");
    expect(extractQuotes(brief)).toEqual(["a real quote here"]);
    expect(extractQuotes('~~~\nlog("tilde fenced code text");\n~~~')).toEqual([]);
    expect(extractQuotes('- "run `npm test` before every merge"')).toEqual(["run npm test before every merge"]);
  });

  it("reads one line at a time: a line break, a carriage return or a fence ends a quote; a repeated quote is listed once", () => {
    expect(extractQuotes('"open on one\nline two" and "same three words" "same three words"')).toEqual(["same three words"]);
    expect(extractQuotes('"one two\rthree four"')).toEqual([]);
    expect(extractQuotes('"we will ```x\ny``` ship it now"')).toEqual([]);
  });

  it("does not pair inch marks or a quote mark inside a word", () => {
    expect(extractQuotes('a 5" panel and a 7" tablet with more words')).toEqual([]);
    expect(extractQuotes('He said"no way at all"ok, then "three real words".')).toEqual(["three real words"]);
    // A straight mark right after a word opens nothing, one right before a word closes nothing.
    expect(extractQuotes('id"one two three" rest')).toEqual([]);
    expect(extractQuotes('"one two three"x rest')).toEqual([]);
  });

  it("reads a quote inside a quote and the outer quote, whichever kind is read first", () => {
    expect(extractQuotes('- "Keep the label “beta release tag” until launch"')).toEqual([
      "Keep the label “beta release tag” until launch",
      "beta release tag",
    ]);
    expect(extractQuotes('- "Never retry when "database is locked" appears"')).toEqual([
      'Never retry when "database is locked" appears',
      "database is locked",
    ]);
    expect(extractQuotes('„sagte "eins zwei drei" dann“')).toEqual(['sagte "eins zwei drei" dann', "eins zwei drei"]);
    expect(extractQuotes("»Er sagte „nur mit Tests“ und ging«")).toEqual(["Er sagte „nur mit Tests“ und ging", "nur mit Tests"]);
  });

  it("misreads a German quote with an English one inside (up to the inner mark) and reads no «… »…« …»", () => {
    expect(extractQuotes("„Wir nehmen ab jetzt “nur mit Tests” und gehen“")).toEqual(["Wir nehmen ab jetzt"]);
    expect(extractQuotes("«Er sagte »nur mit Tests« und ging»")).toEqual([]);
  });

  it(`reads quotes ${MAX_NESTING} levels deep and stays linear on deeper nesting`, () => {
    expect(MAX_NESTING).toBe(3);
    const deep = (n: number) => `${'"a b c '.repeat(n)}x${' d e f"'.repeat(n)}`;
    expect(extractQuotes(`- ${deep(2)}`)).toHaveLength(2);
    const t0 = Date.now();
    extractQuotes(deep(6_000));
    unverifiedQuotes('- "a b c d e f g"', `[Cairn check] x: ${deep(6_000)}`);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
});

describe("normalizeForQuotes", () => {
  it("folds case, ß, whitespace, apostrophes and dashes; drops quote, emphasis and code marks; NFKC turns … into ...", () => {
    expect(normalizeForQuotes(`  Don’t${NBSP}**Switch**\n to \`Postgres\`…  `)).toBe("don't switch to postgres...");
    expect(normalizeForQuotes(`„a“ “b” «c» "d" ${ch(0x2033)}e${ch(0x2033)}`)).toBe("a b c d e");
    expect(normalizeForQuotes("Straße STRASSE")).toBe("strasse strasse");
    expect(normalizeForQuotes(`_never_ ~~old~~ ~5 ms x – y — z − w don´t it${MOD_APOS}s`)).toBe("never old ~5 ms x - y - z - w don't it's");
    expect(normalizeForQuotes(`soft${SHY}hy${ZWSP}phen${BOM}`)).toBe("softhyphen");
  });

  it("reads escapes: \\n, \\t, \\r as a space, a backslash before punctuation dropped", () => {
    expect(normalizeForQuotes('line one\\nline two\\t\\"quoted\\" refresh\\_token\\_ttl \\[x\\]')).toBe("line one line two quoted refreshtokenttl [x]");
  });

  it("reads a Markdown link as its text and leaves `>` alone (the source drops quote markers)", () => {
    expect(normalizeForQuotes("[see the docs](https://example.test/a) first")).toBe("see the docs first");
    expect(normalizeForQuotes("> 100 ms")).toBe("> 100 ms");
  });

  it("stays linear on many brackets without a link and on long runs of combining marks", () => {
    const t0 = Date.now();
    normalizeForQuotes("[".repeat(200_000));
    normalizeForQuotes("[a](".repeat(100_000));
    const marks = `a${(ch(0x316) + ch(0x300)).repeat(250_000)}`;
    normalizeForQuotes(marks);
    unverifiedQuotes('"one two three"', marks);
    // Also escaped marks (JSON from Python's json.dumps), and U+FF9E/U+FF9F, which NFKC makes marks of.
    unverifiedQuotes('"one two three"', `{"t": "a${(esc(0x316) + esc(0x300)).repeat(83_000)}"}`);
    unverifiedQuotes('"one two three"', `a${(ch(0x316) + ch(0xff9e)).repeat(150_000)}`);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(normalizeForQuotes(`e${ch(0x301)}`)).toBe("\u00e9".normalize("NFKC"));
  });

  it("joins words by a hyphen, an en dash or a minus; separates them by an em dash", () => {
    expect(normalizeForQuotes(`non${ch(0x2010)}blocking a${ch(0x2014)}b c ${ch(0x2013)} d`)).toBe("non-blocking a - b c - d");
    expect(normalizeForQuotes(`1${ch(0x2013)}2 h Mo${ch(0x2013)}Fr ${ch(0x2212)}5`)).toBe("1-2 h mo-fr -5");
  });
});

describe("unverifiedQuotes", () => {
  const source = [
    "USER: Go with (a) now, keep (b) as a follow-up ticket. Do not switch to Postgres.",
    'ASSISTANT: the README still says "SQLite needs no configuration".',
    "Sara: (2) **Keine Tokens im localStorage** (XSS) — nur httpOnly+Secure-Cookie.",
    "Ben: we keep losing writes when two workers",
    "flush at the same time.",
  ].join("\n");

  it("accepts quotes found word for word, despite case, line breaks, emphasis and edge punctuation", () => {
    const brief = [
      '- "Go with (a) now, keep (b) as a follow-up ticket." (user)',
      '- README line: "SQLite needs no configuration"',
      "- „keine Tokens im localStorage“",
      '- "We keep losing writes when two workers flush at the same time"',
      '- "Do not switch to Postgres."',
      '- "keep (b) as a follow-up ticket,"',
      '- "...keep (b) as a follow-up ticket"',
    ].join("\n");
    expect(unverifiedQuotes(brief, source)).toEqual([]);
  });

  it("finds a quote that contains inline code, written with or without the backticks", () => {
    const src = "Sara: run `npm test` before every merge, no exceptions.";
    expect(unverifiedQuotes('- "run `npm test` before every merge" (Sara)', src)).toEqual([]);
    expect(unverifiedQuotes('- "run npm test before every merge"', src)).toEqual([]);
    expect(unverifiedQuotes('- "run `npm ci` before every merge"', src)).toEqual(["run npm ci before every merge"]);
  });

  it("flags a paraphrase, an invented directive and a translation", () => {
    const brief = [
      '- "Option (b) must not touch the worker protocol"',
      '- "Do not migrate to Postgres."',
      '- "No tokens in localStorage"',
    ].join("\n");
    expect(unverifiedQuotes(brief, source)).toEqual([
      "Option (b) must not touch the worker protocol",
      "Do not migrate to Postgres.",
      "No tokens in localStorage",
    ]);
  });

  it("needs the quote in one piece: an omission (… or [insertion]) is not word for word", () => {
    expect(unverifiedQuotes('"Go with (a) now … Do not switch to Postgres."', source)).toHaveLength(1);
    expect(unverifiedQuotes('"we will ... ship on Friday"', "we will not ship on Friday")).toHaveLength(1);
    expect(unverifiedQuotes('"We will [not] deploy today"', "We will deploy today")).toHaveLength(1);
  });

  it("needs word boundaries: part of a longer word, or of one joined by - . /, does not count", () => {
    expect(unverifiedQuotes('"safe to deploy on Friday"', "it is unsafe to deploy on Friday")).toHaveLength(1);
    expect(unverifiedQuotes('"use the main branch"', "we reuse the main branches")).toHaveLength(1);
    expect(unverifiedQuotes('"allow writes on replicas"', "disallow writes on replicas")).toHaveLength(1);
    expect(unverifiedQuotes('"deploy to the main branch"', "deploy to the main branches")).toHaveLength(1);
    expect(unverifiedQuotes('"blocking writes everywhere"', "use non-blocking writes everywhere")).toHaveLength(1);
    expect(unverifiedQuotes('"pin version 22.10"', "pin version 22.10.1 for now")).toHaveLength(1);
    expect(unverifiedQuotes('"edit the config/prod"', "edit the config/prod/app.yml first")).toHaveLength(1);
    expect(unverifiedQuotes('"pin version 22.10"', "pin version 22.10. Then ship.")).toEqual([]);
    // A dash, also without blanks, separates words.
    expect(unverifiedQuotes('"switch to Postgres now"', `Decision${ch(0x2014)}switch to Postgres now.`)).toEqual([]);
    expect(unverifiedQuotes('"keep it short - two lines max"', `keep it short${ch(0x2014)}two lines max`)).toEqual([]);
    expect(unverifiedQuotes('"1-2 h per run"', `about 1${ch(0x2013)}2 h per run`)).toEqual([]);
    // Punctuation outside the BMP at a quote's edge is trimmed like any other.
    expect(unverifiedQuotes(`"switch to Postgres now${String.fromCodePoint(0x10100)}"`, "switch to Postgres now.")).toEqual([]);
    // Also for a quote that starts or ends with a symbol.
    expect(unverifiedQuotes('"$HOME stays unset in CI"', "x$HOME stays unset in CI")).toHaveLength(1);
    expect(unverifiedQuotes('"$HOME stays unset in CI"', "Make sure $HOME stays unset in CI.")).toEqual([]);
  });

  it("does not let a quote drop a negation before it, with a word or punctuation between (EN and DE)", () => {
    for (const [quote, src] of [
      ['"switch to Postgres now"', "Do not switch to Postgres now."],
      ['"deploy on Fridays again"', "Don't deploy on Fridays again."],
      ['"deploy on Fridays again"', "We do not yet deploy on Fridays again."],
      ['"force push to main"', "Never --force push to main."],
      ['"force push to main"', "Never >> force push to main."],
      ['"deploy on Fridays again"', "We do not well-tested deploy on Fridays again."],
      ["„Wir deployen am Freitag“", "Wir deployen am Freitag auch nicht."],
      ['"(re)start the worker by hand"', "Do not (re)start the worker by hand."],
      ['"$HOME stays unset in CI"', "Make sure not $HOME stays unset in CI."],
      ['"touch the worker protocol"', "Ship it without touching the worker protocol, without touch the worker protocol."],
      ['"rotate keys by hand"', "We cannot rotate keys by hand."],
      ["„auf Postgres wechseln wir“", "Nein, nicht auf Postgres wechseln wir."],
      ['"Tokens im localStorage ablegen"', "Keine Tokens im localStorage ablegen."],
      ["„ohne Review mergen wir“", "Nichts davon: ohne Review mergen wir nie."],
      ["„Review mergen wir heute“", "Ohne Review mergen wir heute."],
      ["„davon übernehmen wir jetzt“", "Nichts davon übernehmen wir jetzt."],
      ["„Wir deployen am Freitag“", "Wir deployen am Freitag nicht."],
    ] as const) {
      expect(unverifiedQuotes(quote, src), `${quote} / ${src}`).toHaveLength(1);
    }
    for (const [quote, src] of [
      ["„Wir deployen am Freitag“", "Wir deployen am Freitag nicht mehr."],
      ["„Wir deployen am Freitag“", `Wir deployen am Freitag nicht ${ch(0x2013)} wie besprochen.`],
      ["„Wir deployen am Freitag“", "Wir deployen am Freitag nie (das war klar)."],
    ] as const) {
      expect(unverifiedQuotes(quote, src), `${quote} / ${src}`).toHaveLength(1);
    }
    expect(unverifiedQuotes('"Keine Tokens im localStorage ablegen"', "Keine Tokens im localStorage ablegen.")).toEqual([]);
    // An affirming phrase after a negation word is none.
    for (const [quote, src] of [
      ['"switch to Postgres now"', "No doubt, switch to Postgres now."],
      ['"deploy on Fridays too"', "We not only deploy on Fridays too."],
      ['"switch to Postgres now"', "Without question switch to Postgres now."],
      ["„nehmen wir Postgres“", "Ohne Zweifel nehmen wir Postgres."],
      ["„am Freitag deployen wir“", "Nicht nur am Freitag deployen wir."],
      ["„nehmen wir Postgres“", "Ohne Frage nehmen wir Postgres."],
      ['"deploy on Fridays too"', "We not just deploy on Fridays too."],
      ['"switch to Postgres now"', "No doubt we switch to Postgres now."],
      // Punctuation right after the word in between ends the negation: "don't worry, …".
      ['"switch to Postgres now"', "Don't worry, switch to Postgres now."],
      // So does a dash with blanks around it ("--" written for one too); a "--" right before the quote does not.
      ['"we use Postgres"', `Not Redis ${ch(0x2014)} we use Postgres.`],
      ['"switch to Postgres now"', `No ${ch(0x2014)} switch to Postgres now.`],
      ['"we use Postgres"', "Nicht Redis -- we use Postgres."],
      ['"force push to main"', "Never -- force push to main."],
      // From a golden probe: a spaced dash after "nicht".
      ["„verworfen. Immutable Digest pinnen“", `Nicht reproduzierbar ${ch(0x2014)} **verworfen**. Immutable Digest pinnen.`],
    ] as const) {
      expect(unverifiedQuotes(quote, src), `${quote} / ${src}`).toEqual([]);
    }
    // A contrast after the quote is no negation of it; another occurrence without the negation counts.
    expect(unverifiedQuotes("„Wir deployen am Freitag“", "Wir deployen am Freitag nicht am Montag.")).toEqual([]);
    expect(unverifiedQuotes('"switch to Postgres fully"', "Do not switch to Postgres fully yet. Next quarter we switch to Postgres fully.")).toEqual([]);
    // A word cut by the window start is no negation word ("knot" read from its last letters).
    expect(unverifiedQuotes('"switch to Postgres now"', `knot ${"-".repeat(44)}switch to Postgres now.`)).toEqual([]);
    expect(unverifiedQuotes('"switch to Postgres now"', `not ${"-".repeat(43)}switch to Postgres now.`)).toHaveLength(1);
    // A letter outside the BMP right before the window counts as a letter: the start cuts "𠀀not".
    const astral = String.fromCodePoint(0x20000);
    expect(unverifiedQuotes('"switch to Postgres now"', `${astral}not ${"-".repeat(44)}switch to Postgres now.`)).toEqual([]);
    expect(unverifiedQuotes('"switch to Postgres now"', `${astral}not ${"-".repeat(43)}switch to Postgres now.`)).toEqual([]);
    // A word right at the window start that the start does not cut stays a word.
    expect(unverifiedQuotes('"switch to Postgres now"', `xx not ${"-".repeat(44)}switch to Postgres now.`)).toHaveLength(1);
    // A word that only ends in a negation is none ("Reno"); across a sentence end, "not" negates nothing after it.
    expect(unverifiedQuotes('"deploy on Fridays again"', "In Reno deploy on Fridays again.")).toEqual([]);
    expect(unverifiedQuotes('"switch to Postgres fully"', "I do not know. Switch to Postgres fully.")).toEqual([]);
  });

  it("checks a quote inside a quote and the outer quote", () => {
    const src = "Lea: Keep the label “beta release tag” until launch. The log shows \"database is locked\" twice.";
    expect(unverifiedQuotes('- "Keep the label “beta release tag” until launch"', src)).toEqual([]);
    expect(unverifiedQuotes('- "Never retry when "database is locked" appears"', src)).toEqual(['Never retry when "database is locked" appears']);
  });

  it("forgives Markdown, escapes and typography the model changed", () => {
    const src = "> _Never_ retry on SQLITE_BUSY errors,\n> > keep it short — two lines max. [See the docs](https://x.test) before merging.";
    const brief = '- "never retry on SQLITE_BUSY errors"\n- "keep it short - two lines max"\n- "See the docs before merging"';
    expect(unverifiedQuotes(brief, src)).toEqual([]);
    const json = JSON.stringify({ text: 'first line\nGo with (a) now, keep (b) open\nthe README says "SQLite needs no configuration"' });
    expect(unverifiedQuotes('- "Go with (a) now, keep (b) open"\n- "SQLite needs no configuration"', json)).toEqual([]);
    expect(unverifiedQuotes('- "use the refresh_token_ttl setting"', "use the refresh\\_token\\_ttl setting")).toEqual([]);
    // JSON with escaped non-ASCII (Python's json.dumps) and quote markers after a literal \n.
    expect(unverifiedQuotes("- „Prüfung vor jedem Merge“", '{"t": "Pr\\u00fcfung vor jedem Merge"}')).toEqual([]);
    expect(unverifiedQuotes('- "Please keep the worker protocol as is"', '{"t": "x\\n> Please keep the\\n> worker protocol as is"}')).toEqual([]);
    expect(unverifiedQuotes(`- "it's our decision to stay"`, `it${MOD_APOS}s our decision to stay`)).toEqual([]);
    // Quote markers at the start of wrapped source lines, also nested, are layout.
    expect(unverifiedQuotes('- "Please keep the worker protocol as is"', "> Please keep the\n> worker protocol as is")).toEqual([]);
    expect(unverifiedQuotes('- "Please keep the worker protocol as is"', "> > Please keep the\n> > worker protocol as is")).toEqual([]);
  });

  it("keeps a measuring sign: `>` and `~` in a quote must be in the source", () => {
    expect(unverifiedQuotes('"> 100 ms means degraded"', "< 100 ms means degraded")).toHaveLength(1);
    expect(unverifiedQuotes('"~5 ms latency budget"', "5 ms latency budget")).toHaveLength(1);
    // A `>` before a number at a source line start is no quote marker.
    expect(unverifiedQuotes('"> 100 ms means degraded"', "> 100 ms means degraded")).toEqual([]);
  });

  it(`does not search a quote over ${MAX_QUOTE_CHARS} characters: it counts as unverified`, () => {
    const text = Array.from({ length: 400 }, (_, i) => `w${i}`).join(" ");
    // Prefixes of the source that end at a word end: just over and at most the bound.
    const long = text.slice(0, text.indexOf(" ", MAX_QUOTE_CHARS));
    const fits = text.slice(0, text.lastIndexOf(" ", MAX_QUOTE_CHARS));
    expect(long.length).toBeGreaterThan(MAX_QUOTE_CHARS);
    expect(unverifiedQuotes(`- "${long}"`, text)).toEqual([long]);
    expect(unverifiedQuotes(`- "${fits}"`, text)).toEqual([]);
    const t0 = Date.now();
    unverifiedQuotes(`- "${"a, b. ".repeat(300_000)}x"`, "a, b. ".repeat(300_000));
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it("stays linear on carriage-return lines (progress bars) with notes and (derived) items", () => {
    const t0 = Date.now();
    unverifiedQuotes('"one two three"', " 50%|#####     | 50/100 [00:01<00:01]\r".repeat(25_000));
    unverifiedQuotes('"one two three"', '[Cairn check] Not found: "a b c d"\r'.repeat(25_000));
    unverifiedQuotes('"one two three"', "- inferred step (derived)\r".repeat(40_000));
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it("stays linear on a long run of punctuation before a match", () => {
    const t0 = Date.now();
    unverifiedQuotes('"switch to Postgres now"', `${"- ".repeat(500_000)}switch to Postgres now ${"-".repeat(500_000)}`);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it("keeps a quote unverified that a Cairn check note in the source lists", () => {
    const invented = "Option (b) must not touch the worker protocol";
    const note = (lang: "en" | "de") => t(lang).handoff.unverifiedNote({ quotes: `"${invented}"` });
    const resumed = `4) CONSTRAINTS\n- "${invented}"\n\n${note("en")}`;
    const brief = `- "${invented}"\n- "Do not switch to Postgres."`;
    expect(unverifiedQuotes(brief, `${source}\n${resumed}`)).toEqual([invented]);
    expect(unverifiedQuotes(brief, `${source}\n- "${invented}"\n\n${note("de")}`)).toEqual([invented]);
    // Without the note the earlier copy would count as the source.
    expect(unverifiedQuotes(brief, `${source}\n4) CONSTRAINTS\n- "${invented}"`)).toEqual([]);
    // A part of a noted quote, or a quote around one, stays unverified too (also a real inner quote: the safe side).
    expect(unverifiedQuotes('- "must not touch the worker protocol"', `${source}\n${resumed}`)).toEqual(["must not touch the worker protocol"]);
  });

  it("reads a note in escaped text, in any case, Markdown-escaped, JSON-escaped ü or decomposed ü", () => {
    const invented = "Option (b) must not touch the worker protocol";
    const brief = `- "${invented}"\n- "keep (b) as a follow-up ticket"`;
    const body = `- "${invented}"\n- "keep (b) as a follow-up ticket"`;
    const json = JSON.stringify({ rationale: `${body}\n\n${t("en").handoff.unverifiedNote({ quotes: `"${invented}"` })}\n- "keep (b) as a follow-up ticket"` });
    expect(unverifiedQuotes(brief, json)).toEqual([invented]);
    for (const prefix of ["[cairn check]", "\\[Cairn check\\]", "[Cairn-Pr\\u00fcfung]", `[Cairn-Pru${DIAERESIS}fung]`]) {
      expect(unverifiedQuotes(brief, `${body}\n${prefix} x: "${invented}"`), prefix).toEqual([invented]);
    }
  });

  it("splits (derived) items at straight quotes and escaped line ends, so the text around them stays source", () => {
    const quote = '- "keep the worker protocol as is"';
    for (const src of [
      '{"items":["keep the worker protocol as is","Option (b) would touch it (derived)"]}',
      'Keep the worker protocol as is, and tag guesses "(derived)".',
      'Tim: keep the worker protocol as is and mark the rest "(derived)".',
      '- "keep the worker protocol as is" means (b) waits (derived)',
    ]) {
      expect(unverifiedQuotes(quote, src), src).toEqual([]);
    }
    expect(unverifiedQuotes('- "Option (b) would touch it"', '{"items":["keep it","Option (b) would touch it (derived)"]}')).toHaveLength(1);
    const cr = JSON.stringify({ r: "- keep (b) as a ticket\r- Option (b) touches it (derived)\r- more" });
    expect(unverifiedQuotes('- "keep (b) as a ticket"\n- "Option (b) touches it"', cr)).toEqual(["Option (b) touches it"]);
  });

  it("ends a note at a carriage return like at a line feed", () => {
    const src = '[Cairn check] x: "Option (b) must not touch the worker protocol"\r- "keep (b) as a follow-up ticket"';
    expect(unverifiedQuotes('- "keep (b) as a follow-up ticket"', src)).toEqual([]);
  });

  it("reads no note in the middle of a line, and no source in a line marked (derived)", () => {
    const src = 'Lea: the [Cairn check] line said "keep (b) as a follow-up ticket" is fine';
    expect(unverifiedQuotes('- "keep (b) as a follow-up ticket"', src)).toEqual([]);
    const earlier = "4) CONSTRAINTS\n- Target: 0 lost writes under 8 workers (derived)";
    expect(unverifiedQuotes('- "Target: 0 lost writes under 8 workers"', earlier)).toHaveLength(1);
    // Only an item that ends in (derived) is dropped: in escaped text up to a literal \n, a mention elsewhere stays.
    const json = JSON.stringify({ b: "- keep (b) as a follow-up ticket\n- Target: 0 lost writes under 8 workers (derived)\n- more" });
    expect(unverifiedQuotes('- "Target: 0 lost writes under 8 workers"\n- "keep (b) as a follow-up ticket"', json)).toEqual([
      "Target: 0 lost writes under 8 workers",
    ]);
    expect(unverifiedQuotes('- "keep the worker protocol as is"', "Lea: the (derived) marker is fine, keep the worker protocol as is")).toEqual([]);
    // The last item of an escaped brief ends at the string's closing quote, or before an escaped \r\n.
    const last = "- Option (b): it would touch the worker protocol (derived)";
    for (const src of [
      JSON.stringify({ rationale: `- keep (b) as a follow-up ticket\n${last}` }),
      JSON.stringify({ rationale: `- keep (b) as a follow-up ticket\r\n${last}\r\n- more` }),
      `- keep (b) as a follow-up ticket\n- Option (b): it would touch the worker protocol **(derived)**`,
      `- keep (b) as a follow-up ticket\n- Option (b): it would touch the worker protocol (derived);`,
    ]) {
      expect(unverifiedQuotes('- "it would touch the worker protocol"\n- "keep (b) as a follow-up ticket"', src), src).toEqual([
        "it would touch the worker protocol",
      ]);
    }
  });

  it("the note prefixes are the ones both catalogs write", () => {
    for (const lang of ["en", "de"] as const) {
      expect(NOTE_PREFIXES.some((p) => t(lang).handoff.unverifiedNote({ quotes: '"x"' }).startsWith(p))).toBe(true);
    }
  });

  it("reports nothing for a brief without quotes", () => {
    expect(unverifiedQuotes("1) DECISIONS\n- Option (a) chosen.", source)).toEqual([]);
  });
});
