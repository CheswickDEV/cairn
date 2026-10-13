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
    expect(p).toContain(lang === "en" ? "by appending (derived)." : "mit angehängtem (derived).");
  });

  it("states each rule in both languages: empty bucket, measured value, deferral, exact words in double quotes", () => {
    const en = t("en").prompts.sevenBucket;
    const de = t("de").prompts.sevenBucket;
    for (const rule of ["write 'none' in an empty bucket", "A measured value is not a target.", "a deferred option is not discarded.",
      "give it in their exact words in double quotes; use\ndouble quotes for nothing else.", "no constraint, target, reason or step the context does\nnot state."]) {
      expect(en).toContain(rule);
    }
    for (const rule of ["ein leerer Bucket bekommt 'keine'", "Ein Messwert ist kein Ziel.", "Vertagtes ist nicht verworfen.",
      "mit ihren genauen Worten in doppelten Anführungszeichen wieder; sonst keine doppelten Anführungszeichen.",
      "keine Rahmenbedingung, kein Ziel, kein Grund und\nkein Schritt, den der Kontext nicht nennt."]) {
      expect(de).toContain(rule);
    }
  });
});

// Type-level guard: both catalogs implement the same interface (compile-time parity).
const _enTyped: Messages = messages.en;
const _deTyped: Messages = messages.de;
void _enTyped;
void _deTyped;
