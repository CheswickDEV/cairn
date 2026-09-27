/**
 * Cairn - PreCompact hook logic (ADR-0001/0004/0007 surface).
 *
 * Fires BEFORE Claude Code compacts. A PreCompact hook canNOT supply/replace the host's compaction
 * summary, and any context it emits is itself summarized (claude-code#14258) - so its job is to
 * DETECT + SECURE: record the compaction event and (when the bin passes a transcript tail) persist
 * it byte-exact as a verbatim safety-net (ADR-0004: rather a lossless snapshot than lost context).
 * The faithful brief is carried into the continued context by the `SessionStart`(`compact`) hook,
 * which fires AFTER compaction (not summarized). Pure; the bin does stdin + transcript read + store.
 */

import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { StoreApi } from "../store/types.js";
import { t, type Lang } from "../i18n/index.js";

/** Resolve symlinks when the path exists; otherwise keep the lexically resolved path. */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Security guard (audit findings 6 + N1): a transcript is only readable if it is a `.jsonl` file
 *  strictly under `<claudeRoot>/projects/` after resolving `../` and symlinks. The whole Claude root is
 *  NOT trusted: it also holds `.credentials.json`, `settings.json` and other files that must never be
 *  slurped into the store by a spoofed hook payload. */
export function isAllowedTranscriptPath(
  path: string,
  claudeRoot: string,
  realpath: (p: string) => string = realpathOrSelf,
): boolean {
  if (!path.toLowerCase().endsWith(".jsonl")) return false;
  const p = realpath(resolve(path));
  const projects = realpath(resolve(claudeRoot, "projects"));
  return p.toLowerCase().endsWith(".jsonl") && p.startsWith(projects + sep);
}

export interface PreCompactInput {
  trigger?: string; // "auto" | "manual"
  sessionId?: string;
  /** Optional raw transcript tail captured by the bin, stored byte-exact as a fallback. */
  transcriptTail?: string;
  ts?: string;
}

export interface PreCompactResult {
  systemMessage: string;
  decisionId: string;
  storedTail: boolean;
}

export function buildPreCompactResult(
  store: StoreApi,
  input: PreCompactInput = {},
  lang: Lang = "en",
): PreCompactResult {
  const m = t(lang).preCompact;
  const trigger = input.trigger ?? "auto";
  const d = store.appendDecision({
    who: "cairn-precompact",
    decision: m.decision({ trigger }),
    rationale: m.rationale({ session: input.sessionId }),
    status: "accepted",
    ts: input.ts,
  });

  let storedTail = false;
  if (input.transcriptTail && input.transcriptTail.length > 0) {
    store.addEvidence({
      decisionId: d.decisionId,
      claim: m.transcriptTailClaim,
      sourceRef: "transcript",
      type: "tool_out",
      verbatim: input.transcriptTail,
    });
    storedTail = true;
  }

  return {
    systemMessage: m.systemMessage,
    decisionId: d.decisionId,
    storedTail,
  };
}
