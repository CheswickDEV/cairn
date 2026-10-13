import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveLang,
  readPersistedLang,
  persistLang,
  langConfigPath,
  isLang,
  DEFAULT_LANG,
} from "./lang.js";
import { messages, t, type Messages } from "./messages.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "cairn-i18n-"));
}

describe("resolveLang — precedence: CAIRN_LANG > persisted config.json > 'en'", () => {
  it("defaults to English when nothing is set", () => {
    const home = tempHome();
    try {
      expect(resolveLang({ CAIRN_HOME: home })).toBe("en");
      expect(DEFAULT_LANG).toBe("en");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses the persisted config.json when no env override is present", () => {
    const home = tempHome();
    try {
      persistLang("de", { CAIRN_HOME: home });
      expect(readPersistedLang({ CAIRN_HOME: home })).toBe("de");
      expect(resolveLang({ CAIRN_HOME: home })).toBe("de");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("CAIRN_LANG env overrides the persisted value", () => {
    const home = tempHome();
    try {
      persistLang("de", { CAIRN_HOME: home });
      expect(resolveLang({ CAIRN_HOME: home, CAIRN_LANG: "en" })).toBe("en");
      expect(resolveLang({ CAIRN_HOME: home, CAIRN_LANG: "de" })).toBe("de");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores an invalid CAIRN_LANG and an invalid/corrupt config", () => {
    const home = tempHome();
    try {
      // invalid env → falls through to persisted/default
      expect(resolveLang({ CAIRN_HOME: home, CAIRN_LANG: "fr" })).toBe("en");
      // corrupt config.json → undefined → default
      writeFileSync(langConfigPath({ CAIRN_HOME: home }), "{ not json", "utf8");
      expect(readPersistedLang({ CAIRN_HOME: home })).toBeUndefined();
      expect(resolveLang({ CAIRN_HOME: home })).toBe("en");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("persistLang merges, preserving other keys in config.json", () => {
    const home = tempHome();
    try {
      writeFileSync(langConfigPath({ CAIRN_HOME: home }), JSON.stringify({ other: 1 }), "utf8");
      persistLang("de", { CAIRN_HOME: home });
      const raw = JSON.parse(readFileSync(langConfigPath({ CAIRN_HOME: home }), "utf8"));
      expect(raw).toEqual({ other: 1, lang: "de" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("isLang", () => {
  it("accepts only en/de", () => {
    expect(isLang("en")).toBe(true);
    expect(isLang("de")).toBe(true);
    expect(isLang("fr")).toBe(false);
    expect(isLang(undefined)).toBe(false);
  });
});

/** Collect "key → leaf kind" for every nested leaf so the two locales can be compared structurally. */
function shape(obj: Record<string, unknown>, prefix = ""): Record<string, "fn" | "str" | "other"> {
  const out: Record<string, "fn" | "str" | "other"> = {};
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "function") out[path] = "fn";
    else if (typeof v === "string") out[path] = "str";
    else if (v && typeof v === "object") Object.assign(out, shape(v as Record<string, unknown>, path));
    else out[path] = "other";
  }
  return out;
}

describe("catalog locale parity (en ⇿ de)", () => {
  it("every leaf key exists in both locales with the same kind", () => {
    const en = shape(messages.en as unknown as Record<string, unknown>);
    const de = shape(messages.de as unknown as Record<string, unknown>);
    expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort());
    for (const key of Object.keys(en)) expect(de[key]).toBe(en[key]);
  });

  it("t(lang) returns distinct, language-appropriate copy for sampled keys", () => {
    expect(t("en").decisionLog.header({ count: 2, view: "current" })).toBe("2 decision(s) [current]:");
    expect(t("de").decisionLog.header({ count: 2, view: "current" })).toBe("2 Entscheidung(en) [current]:");
    expect(t("en").statusline.hint.red).toBe(" · context high");
    expect(t("de").statusline.hint.red).toBe(" · Kontext hoch");
    expect(t("en").prompts.sevenBucket).toContain("7 buckets");
    expect(t("de").prompts.sevenBucket).toContain("7 Buckets");
  });
});

describe("7-bucket prompt — grounding rules (ADR-0013)", () => {
  const BUCKETS = ["1) DECISIONS", "2) EVIDENCE", "3) OPEN QUESTIONS", "4) CONSTRAINTS", "5) VERBATIM", "6) NEXT STEPS", "7) DISCARDED"];
  it.each(["en", "de"] as const)("%s: the seven buckets in order, then the rules, and the hold markers", (lang) => {
    const p = t(lang).prompts.sevenBucket;
    const at = BUCKETS.map((b) => p.indexOf(b));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(p).toContain("[[CAIRN-HOLD-n]]");
    // The marker for the summarizer's own inference is the same in both languages: the resume skill names it.
    expect(p).toContain(lang === "en" ? "marked by appending (derived)." : "markiert mit angehängtem (derived).");
  });

  it("states each rule in both languages: empty bucket, measured value, deferral, quotes, inference", () => {
    // Line breaks in the catalog are layout only.
    const en = t("en").prompts.sevenBucket.replace(/\s+/g, " ");
    const de = t("de").prompts.sevenBucket.replace(/\s+/g, " ");
    for (const rule of [
      "write 'none' in an empty bucket",
      "A measured value is not a target.",
      "including deferred options.",
      "a deferred option is not discarded.",
      "Invent nothing: state nothing as given that the context does not state.",
      "An inference of your own (a constraint, target, reason or step the context does not state) may appear only as an item of its own, marked by appending (derived).",
      "Put double quotes only around exact words from the context, in one piece without omissions;",
      "give a decision or constraint a person set in their own words, in double quotes.",
    ]) {
      expect(en).toContain(rule);
    }
    for (const rule of [
      "ein leerer Bucket bekommt 'keine'",
      "Ein Messwert ist kein Ziel.",
      "auch vertagte Optionen.",
      "Vertagtes ist nicht verworfen.",
      "Nichts erfinden: Stelle nichts als gegeben dar, was der Kontext nicht nennt.",
      "Eigene Schlüsse (Rahmenbedingungen, Ziele, Gründe oder Schritte, die der Kontext nicht nennt) dürfen nur als eigener Eintrag erscheinen, markiert mit angehängtem (derived).",
      "Doppelte Anführungszeichen nur um genaue Worte aus dem Kontext, am Stück ohne Auslassungen;",
      "gib eine Entscheidung oder Rahmenbedingung, die eine Person festlegt, mit ihren eigenen Worten in doppelten Anführungszeichen wieder.",
    ]) {
      expect(de).toContain(rule);
    }
  });
});

// Type-level guard: both catalogs implement the same interface (compile-time parity).
const _enTyped: Messages = messages.en;
const _deTyped: Messages = messages.de;
void _enTyped;
void _deTyped;
