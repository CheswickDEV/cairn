import { describe, it, expect } from "vitest";
import { extractQuotes, normalizeForQuotes, unverifiedQuotes, MIN_QUOTE_WORDS, NOTE_PREFIXES } from "./grounding.js";
import { t } from "../i18n/index.js";

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
});

describe("normalizeForQuotes", () => {
  it("folds case, ß, whitespace, apostrophes and dashes; drops quote, emphasis and code marks; NFKC turns … into ...", () => {
    expect(normalizeForQuotes("  Don’t **Switch**\n to `Postgres`…  ")).toBe("don't switch to postgres...");
    expect(normalizeForQuotes("„a“ “b” «c» \"d\"")).toBe("a b c d");
    expect(normalizeForQuotes("Straße STRASSE")).toBe("strasse strasse");
    expect(normalizeForQuotes("_never_ ~~old~~ x – y — z − w don´t")).toBe("never old x - y - z - w don't");
    expect(normalizeForQuotes("soft­hy​phen﻿")).toBe("softhyphen");
  });

  it("drops quote markers at line starts and reads a Markdown link as its text", () => {
    expect(normalizeForQuotes("> Please keep the\n> worker protocol\n>> as is")).toBe("please keep the worker protocol as is");
    expect(normalizeForQuotes("[see the docs](https://example.test/a) first")).toBe("see the docs first");
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

  it("needs word boundaries: part of a longer word does not count", () => {
    expect(unverifiedQuotes('"safe to deploy on Friday"', "it is unsafe to deploy on Friday")).toHaveLength(1);
    expect(unverifiedQuotes('"use the main branch"', "we reuse the main branches")).toHaveLength(1);
    expect(unverifiedQuotes('"allow writes on replicas"', "disallow writes on replicas")).toHaveLength(1);
    expect(unverifiedQuotes('"deploy to the main branch"', "deploy to the main branches")).toHaveLength(1);
  });

  it("does not let a quote drop a negation right before it (EN and DE)", () => {
    expect(unverifiedQuotes('"switch to Postgres now"', "Do not switch to Postgres now.")).toHaveLength(1);
    expect(unverifiedQuotes('"deploy on Fridays again"', "Don't deploy on Fridays again.")).toHaveLength(1);
    expect(unverifiedQuotes("„auf Postgres wechseln wir“", "Nein, nicht auf Postgres wechseln wir.")).toHaveLength(1);
    expect(unverifiedQuotes('"Tokens im localStorage ablegen"', "Keine Tokens im localStorage ablegen.")).toHaveLength(1);
    expect(unverifiedQuotes('"Keine Tokens im localStorage ablegen"', "Keine Tokens im localStorage ablegen.")).toEqual([]);
    // Another occurrence without the negation counts.
    expect(unverifiedQuotes('"switch to Postgres fully"', "Do not switch to Postgres fully yet. Next quarter we switch to Postgres fully.")).toEqual([]);
  });

  it("checks a quote inside a quote and the outer quote", () => {
    const src = 'Lea: Keep the label “beta release tag” until launch. The log shows "database is locked" twice.';
    expect(unverifiedQuotes('- "Keep the label “beta release tag” until launch"', src)).toEqual([]);
    expect(unverifiedQuotes('- "Never retry when "database is locked" appears"', src)).toEqual(['Never retry when "database is locked" appears']);
  });

  it("forgives Markdown and typography the model changed", () => {
    const src = "> _Never_ retry on SQLITE_BUSY errors,\n> keep it short — two lines max. [See the docs](https://x.test) before merging.";
    const brief = '- "never retry on SQLITE_BUSY errors"\n- "keep it short - two lines max"\n- "See the docs before merging"';
    expect(unverifiedQuotes(brief, src)).toEqual([]);
  });

  it("keeps a quote unverified that a Cairn check note in the source lists (EN, DE, JSON-escaped)", () => {
    const invented = "Option (b) must not touch the worker protocol";
    const resumed = `4) CONSTRAINTS\n- "${invented}"\n\n${t("en").handoff.unverifiedNote({ quotes: `"${invented}"` })}`;
    const brief = `- "${invented}"\n- "Do not switch to Postgres."`;
    expect(unverifiedQuotes(brief, `${source}\n${resumed}`)).toEqual([invented]);
    const de = `- "${invented}"\n\n${t("de").handoff.unverifiedNote({ quotes: `"${invented}"` })}`;
    expect(unverifiedQuotes(brief, `${source}\n${de}`)).toEqual([invented]);
    // In escaped text the note runs to a literal \n or the line end: the rest of the line is flagged too.
    const json = JSON.stringify({ rationale: resumed, next: "Do not switch to Postgres." });
    expect(unverifiedQuotes(brief, `${source}\n${json}`)).toContain(invented);
    // A literal \n ends the note: a quote after it on the same line is source again.
    const jsonl = JSON.stringify({ rationale: `${resumed}\n- "keep (b) as a follow-up ticket"` });
    expect(unverifiedQuotes(`${brief}\n- "keep (b) as a follow-up ticket"`, jsonl)).toEqual([invented, "Do not switch to Postgres."]);
    // A part of a noted quote, or a quote around one, stays unverified too.
    expect(unverifiedQuotes('- "must not touch the worker protocol"', `${source}\n${resumed}`)).toEqual(["must not touch the worker protocol"]);
    // Without the note the earlier copy would count as the source.
    expect(unverifiedQuotes(brief, `${source}\n4) CONSTRAINTS\n- "${invented}"`)).toEqual([]);
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
