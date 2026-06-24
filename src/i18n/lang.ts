/**
 * Cairn - runtime language resolution + persistence (i18n).
 *
 * English is the DEFAULT; German is a full parallel locale the user opts into - at install
 * (`cairn install --lang de`, persisted) or per session via the `CAIRN_LANG` env var. Resolution:
 *   CAIRN_LANG (en|de)  >  persisted ~/.cairn/config.json { "lang": … }  >  'en'.
 * The persisted value is written ONLY by the installer; every runtime process (the MCP server and
 * the statusline / session-start / pre-compact / codex bins) resolves it cheaply from the JSON file
 * - no DB open required.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Env } from "../core/env.js";

export type Lang = "en" | "de";
export const DEFAULT_LANG: Lang = "en";

export function isLang(v: unknown): v is Lang {
  return v === "en" || v === "de";
}

/** Cairn's state directory (config.json + the SQLite ledger live here). `CAIRN_HOME` overrides;
 *  default `~/.cairn`. Kept separate from `CAIRN_DB` so the language survives a redirected store. */
export function cairnHome(env: Env = process.env): string {
  return env.CAIRN_HOME && env.CAIRN_HOME.length > 0 ? env.CAIRN_HOME : join(homedir(), ".cairn");
}

export function langConfigPath(env: Env = process.env): string {
  return join(cairnHome(env), "config.json");
}

/** Read the persisted language from config.json; undefined if absent / unreadable / invalid. */
export function readPersistedLang(env: Env = process.env): Lang | undefined {
  const path = langConfigPath(env);
  if (!existsSync(path)) return undefined;
  try {
    const obj = JSON.parse(readFileSync(path, "utf8")) as { lang?: unknown };
    return isLang(obj.lang) ? obj.lang : undefined;
  } catch {
    return undefined;
  }
}

/** Persist `{ lang }` into config.json, MERGING with any existing keys. Installer-only. */
export function persistLang(lang: Lang, env: Env = process.env): void {
  const path = langConfigPath(env);
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  mkdirSync(cairnHome(env), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...existing, lang }, null, 2) + "\n", "utf8");
}

/** Resolution order: `CAIRN_LANG` env (en|de) > persisted config.json > 'en'. Never throws. */
export function resolveLang(env: Env = process.env): Lang {
  if (isLang(env.CAIRN_LANG)) return env.CAIRN_LANG;
  return readPersistedLang(env) ?? DEFAULT_LANG;
}
