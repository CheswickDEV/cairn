/**
 * Cairn - SessionStart hook logic (ADR-0001/0006/0007 surface).
 *
 * Reconstructs the live decision state (accepted + open) so the session re-injects prior context
 * via the hook's `additionalContext`. With the hook's `compact` matcher this fires right AFTER a
 * host auto-compaction (NOT subject to summarization) - that is the supported, faithful realization
 * of ADR-0007's in-place continuation (the PreCompact hook cannot replace the host summary). Pure;
 * the bin wrapper opens the store, resolves the language, and wraps this in the SessionStart hook JSON.
 */

import type { StoreApi } from "../store/types.js";
import { isHandoffHead } from "../core/prompts.js";
import { t, type Lang } from "../i18n/index.js";

/** Build the additionalContext text. Returns "" when the store is empty (no injection). */
export function buildSessionStartContext(store: StoreApi, lang: Lang = "en"): string {
  const decisions = store.currentState();
  if (decisions.length === 0) return "";
  const m = t(lang).sessionStart;
  const lines = decisions.map((d) => {
    const ev = store.getEvidence(d.decisionId);
    const evNote = ev.length ? m.evidenceNote({ n: ev.length }) : "";
    const label = isHandoffHead(d.decision) ? m.handoffTitle : d.decision;
    return `• [${d.status}] ${label}${evNote}`;
  });

  const parts = [m.header({ count: decisions.length }), ...lines];

  // Carry the most recent full handoff brief through verbatim (ADR-0007 in-place continuation).
  const briefs = decisions.filter((d) => isHandoffHead(d.decision));
  const latestBrief = briefs.length ? briefs[briefs.length - 1].rationale : "";
  if (latestBrief) parts.push("", m.briefHeader, latestBrief);

  parts.push(m.sourceOfTruth);
  return parts.join("\n");
}
