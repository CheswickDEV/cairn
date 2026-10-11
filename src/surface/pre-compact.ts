/** Legacy internal helpers retained for compatibility and tests.
 * No runtime hook invokes these functions after ADR-0010; the old bin entry points are inert.
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
