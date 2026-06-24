#!/usr/bin/env node
/**
 * Cairn Codex status bin: read the active Codex rollout → one-line zone status on stdout (ADR-0008).
 * `--session <match>` pins a specific session (UUID or path substring); `CAIRN_CODEX_SESSION` env
 * does the same. `--list` prints all recent sessions (UUID · cwd · zone) so you can find one to pin.
 */
import { readCodexStatusLine, listRollouts, codexSessionsDir } from "../surface/codex-rollout.js";
import { t, resolveLang } from "../i18n/index.js";

// Tolerate a reader that closes the pipe early (e.g. `--list | head`).
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

const argv = process.argv.slice(2);
let list = false;
let sessionMatch: string | undefined;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--list") list = true;
  else if (arg === "--session") sessionMatch = argv[++i];
  else if (arg.startsWith("--session=")) sessionMatch = arg.slice("--session=".length);
}

const lang = resolveLang();
if (list) {
  const rows = listRollouts(codexSessionsDir(), {}, lang);
  if (rows.length === 0) {
    process.stdout.write(t(lang).codex.noSessions + "\n");
  } else {
    for (const r of rows) {
      process.stdout.write(`${r.statusLine}  ·  ${r.id}  ·  ${r.cwd ?? "?"}\n`);
    }
  }
} else {
  process.stdout.write(readCodexStatusLine({ sessionMatch }, lang) + "\n");
}
