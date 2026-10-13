import { describe, it, expect } from "vitest";
import { extractQuotes, normalizeForQuotes, unverifiedQuotes, MIN_QUOTE_WORDS } from "./grounding.js";

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

  it("skips fenced code and reads inline code as its text, so a quote may contain it", () => {
    const brief = ['Use `db.pragma("journal_mode = WAL")` here.', "```ts", 'log("this is code text");', "```", '"a real quote here"'].join("\n");
    expect(extractQuotes(brief)).toEqual(["a real quote here"]);
    expect(extractQuotes('- "run `npm test` before every merge"')).toEqual(["run npm test before every merge"]);
  });

  it("reads one line at a time and lists a repeated quote once", () => {
    expect(extractQuotes('"open on one\nline two" and "same three words" "same three words"')).toEqual(["same three words"]);
  });

  it("does not pair inch marks or a quote mark inside a word", () => {
    expect(extractQuotes('a 5" panel and a 7" tablet with more words')).toEqual([]);
    expect(extractQuotes('He said"no way at all"ok, then "three real words".')).toEqual(["three real words"]);
    // A straight mark right after a word opens nothing, one right before a word closes nothing.
    expect(extractQuotes('id"one two three" rest')).toEqual([]);
    expect(extractQuotes('"one two three"x rest')).toEqual([]);
  });

  it("reads a quote inside a found quote as part of it, not as a second quote", () => {
    expect(extractQuotes('„sagte "eins zwei drei" dann“')).toEqual(['sagte "eins zwei drei" dann']);
  });
});

describe("normalizeForQuotes", () => {
  it("folds case, whitespace, apostrophes, quote marks, emphasis and code marks; NFKC turns … into ...", () => {
    expect(normalizeForQuotes("  Don’t **Switch**\n to `Postgres`…  ")).toBe("don't switch to postgres...");
    expect(normalizeForQuotes("„a“ “b” «c»")).toBe('"a" "b" "c"');
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
    ].join("\n");
    expect(unverifiedQuotes(brief, source)).toEqual([]);
  });

  it("finds a quote that contains inline code, written with or without the backticks", () => {
    const src = "Sara: run `npm test` before every merge, no exceptions.";
    expect(unverifiedQuotes('- "run `npm test` before every merge" (Sara)', src)).toEqual([]);
    expect(unverifiedQuotes('- "run npm test before every merge"', src)).toEqual([]);
    expect(unverifiedQuotes('- "run `npm ci` before every merge"', src)).toEqual(["run npm ci before every merge"]);
  });

  it("checks each part of a quote cut by an ellipsis or a bracketed insertion", () => {
    expect(unverifiedQuotes('"Go with (a) now … Do not switch to Postgres."', source)).toEqual([]);
    expect(unverifiedQuotes('"Go with (a) now, keep [option] (b) as a follow-up ticket"', source)).toEqual([]);
    expect(unverifiedQuotes('"Go with (a) now ... never use Postgres"', source)).toEqual(["Go with (a) now ... never use Postgres"]);
  });

  it("flags a paraphrase, an invented directive and a translation", () => {
    const brief = [
      '- "Option (b) must not touch the worker protocol"',
      '- "Do not migrate to Postgres."',
      '- "No tokens in localStorage"',
      '- "Do not switch to Postgres."',
    ].join("\n");
    expect(unverifiedQuotes(brief, source)).toEqual([
      "Option (b) must not touch the worker protocol",
      "Do not migrate to Postgres.",
      "No tokens in localStorage",
    ]);
  });

  it("reports nothing for a brief without quotes", () => {
    expect(unverifiedQuotes("1) DECISIONS\n- Option (a) chosen.", source)).toEqual([]);
  });
});
