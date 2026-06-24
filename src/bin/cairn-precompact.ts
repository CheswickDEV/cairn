#!/usr/bin/env node
/** Cairn PreCompact hook bin: records the compaction event (+ verbatim transcript-tail fallback)
 *  and nudges the agent to produce a 7-bucket brief via `handoff`. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/config.js";
import { resolveLang } from "../i18n/index.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { buildPreCompactResult, isAllowedTranscriptPath } from "../surface/pre-compact.js";

interface PreCompactStdin {
  trigger?: string;
  session_id?: string;
  transcript_path?: string;
}

let input: PreCompactStdin = {};
try {
  const raw = readFileSync(0, "utf8");
  if (raw.trim()) input = JSON.parse(raw) as PreCompactStdin;
} catch {
  input = {};
}

let transcriptTail: string | undefined;
if (typeof input.transcript_path === "string" && isAllowedTranscriptPath(input.transcript_path, join(homedir(), ".claude"))) {
  // Only read transcripts under the trusted Claude root (audit finding 6) - a spoofed hook
  // payload cannot slurp arbitrary files (~/.claude/.credentials.json, /etc/passwd) into the store.
  try {
    transcriptTail = readFileSync(input.transcript_path, "utf8").slice(-8_000);
  } catch {
    /* transcript unreadable - skip the fallback snapshot */
  }
}

const config = loadConfig();
const store = new SqliteStore({ path: config.storePath });
const result = buildPreCompactResult(
  store,
  {
    trigger: input.trigger,
    sessionId: input.session_id,
    transcriptTail,
  },
  resolveLang(),
);
store.close();

process.stdout.write(JSON.stringify({ systemMessage: result.systemMessage }) + "\n");
