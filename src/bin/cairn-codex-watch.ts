#!/usr/bin/env node
/**
 * Cairn Codex watch bin: poll the active Codex rollout every `--interval` seconds and surface the
 * zone ambiently (ADR-0008). Default: write the line as the terminal title via an OSC escape so the
 * zone shows up in the window/tab title (portable, incl. Windows Terminal/PowerShell). `--print`
 * instead refreshes a single line in place (for a dedicated pane). `--session <match>` pins a
 * specific Codex session (UUID or any path substring) for the multi-session case; the
 * `CAIRN_CODEX_SESSION` env var does the same. Pure Node loop - no shell.
 */
import { readCodexStatusLine } from "../surface/codex-rollout.js";
import { t, resolveLang } from "../i18n/index.js";

const lang = resolveLang();

// Tolerate a reader that closes the pipe early.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

interface Opts {
  intervalMs: number;
  print: boolean;
  sessionMatch?: string;
}

function parseArgs(argv: string[]): Opts {
  let intervalSec = 2;
  let print = false;
  let sessionMatch: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--print") {
      print = true;
    } else if (arg === "--interval") {
      intervalSec = Number(argv[++i]);
    } else if (arg.startsWith("--interval=")) {
      intervalSec = Number(arg.slice("--interval=".length));
    } else if (arg === "--session") {
      sessionMatch = argv[++i];
    } else if (arg.startsWith("--session=")) {
      sessionMatch = arg.slice("--session=".length);
    }
  }
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) intervalSec = 2;
  return { intervalMs: intervalSec * 1000, print, sessionMatch };
}

const { intervalMs, print, sessionMatch } = parseArgs(process.argv.slice(2));

function tick(): void {
  let line: string;
  try {
    line = readCodexStatusLine({ sessionMatch }, lang);
  } catch {
    line = t(lang).codex.noContext;
  }
  if (print) {
    // carriage return + clear line → update in place without scrolling
    process.stdout.write("\r\x1b[2K" + line);
  } else {
    // OSC 2: set terminal/window title
    process.stdout.write("\x1b]2;" + line + "\x07");
  }
}

tick();
const timer = setInterval(tick, intervalMs);

function shutdown(): void {
  clearInterval(timer);
  if (print) process.stdout.write("\n");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
