#!/usr/bin/env node
/** Cairn SessionStart hook bin: re-injects the live decision state via `additionalContext`. */
import { readFileSync } from "node:fs";
import { loadConfig } from "../core/config.js";
import { resolveLang } from "../i18n/index.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { buildSessionStartContext } from "../surface/session-start.js";

try {
  readFileSync(0, "utf8"); // consume the hook stdin payload (unused)
} catch {
  /* no stdin */
}

const config = loadConfig();
const store = new SqliteStore({ path: config.storePath });
const additionalContext = buildSessionStartContext(store, resolveLang());
store.close();

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }) + "\n",
);
