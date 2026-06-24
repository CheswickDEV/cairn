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
    expect(t("en").statusline.hint.red).toBe(" · handoff now");
    expect(t("de").statusline.hint.red).toBe(" · handoff jetzt");
    expect(t("en").prompts.sevenBucket).toContain("7 buckets");
    expect(t("de").prompts.sevenBucket).toContain("7 Buckets");
  });
});

// Type-level guard: both catalogs implement the same interface (compile-time parity).
const _enTyped: Messages = messages.en;
const _deTyped: Messages = messages.de;
void _enTyped;
void _deTyped;
