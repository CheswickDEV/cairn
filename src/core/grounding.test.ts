import { describe, it, expect } from "vitest";
import { extractQuotes, normalizeForQuotes, unverifiedQuotes, MIN_QUOTE_WORDS, MAX_NESTING, NOTE_PREFIXES } from "./grounding.js";
import { t } from "../i18n/index.js";

/** Invisible or look-alike characters by code point, so the test file holds none as literals. */
const ch = (...codes: number[]) => String.fromCharCode(...codes);
const NBSP = ch(0xa0), SHY = ch(0xad), ZWSP = ch(0x200b), BOM = ch(0xfeff), MOD_APOS = ch(0x2bc), DIAERESIS = ch(0x308);

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

  it("stays linear on many brackets without a link", () => {
    const t0 = Date.now();
    normalizeForQuotes("[".repeat(200_000));
    normalizeForQuotes("[a](".repeat(100_000));
    expect(Date.now() - t0).toBeLessThan(2_000);
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
    expect(unverifiedQuotes('"Keine Tokens im localStorage ablegen"', "Keine Tokens im localStorage ablegen.")).toEqual([]);
    // A contrast after the quote is no negation of it; another occurrence without the negation counts.
    expect(unverifiedQuotes("„Wir deployen am Freitag“", "Wir deployen am Freitag nicht am Montag.")).toEqual([]);
    expect(unverifiedQuotes('"switch to Postgres fully"', "Do not switch to Postgres fully yet. Next quarter we switch to Postgres fully.")).toEqual([]);
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
    expect(unverifiedQuotes(`- "it's our decision to stay"`, `it${MOD_APOS}s our decision to stay`)).toEqual([]);
    // Quote markers at the start of wrapped source lines, also nested, are layout.
    expect(unverifiedQuotes('- "Please keep the worker protocol as is"', "> Please keep the\n> worker protocol as is")).toEqual([]);
    expect(unverifiedQuotes('- "Please keep the worker protocol as is"', "> > Please keep the\n> > worker protocol as is")).toEqual([]);
  });

  it("keeps a measuring sign: `>` and `~` in a quote must be in the source", () => {
    expect(unverifiedQuotes('"> 100 ms means degraded"', "< 100 ms means degraded")).toHaveLength(1);
    expect(unverifiedQuotes('"~5 ms latency budget"', "5 ms latency budget")).toHaveLength(1);
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

  it("reads no note in the middle of a line, and no source in a line marked (derived)", () => {
    const src = 'Lea: the [Cairn check] line said "keep (b) as a follow-up ticket" is fine';
    expect(unverifiedQuotes('- "keep (b) as a follow-up ticket"', src)).toEqual([]);
    const earlier = "4) CONSTRAINTS\n- Target: 0 lost writes under 8 workers (derived)";
    expect(unverifiedQuotes('- "Target: 0 lost writes under 8 workers"', earlier)).toHaveLength(1);
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
