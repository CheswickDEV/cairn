/**
 * Cairn - the canonical 7-bucket compaction prompt (ADR-0002) + the stable handoff-head key.
 *
 * The localized prompt text now lives in the i18n catalog (`messages[lang].prompts.sevenBucket`);
 * callers that compact in a user-facing language read it via `t(lang)`. `SEVEN_BUCKET_PROMPT` below
 * is re-exported as the GERMAN catalog entry so the calibration harness/golden sets stay byte-stable
 * (they were tuned against the German prompt).
 */

import { messages } from "../i18n/messages.js";

/**
 * STABLE, language-independent key stored in the `decision` column of every handoff-brief head.
 * A new handoff supersedes the previous head by matching on THIS key (never a localized title), so
 * switching language mid-project does not orphan prior heads and re-injection carries only the
 * LATEST brief. The SessionStart hook (session-start.ts) keys off the same constant.
 */
export const HANDOFF_DECISION_KEY = "cairn:handoff-brief";

/** Legacy head value persisted by pre-i18n builds. Matched alongside HANDOFF_DECISION_KEY so an
 *  existing German ledger still supersedes/re-injects correctly after upgrade. */
export const LEGACY_HANDOFF_TITLE_DE = "Session-Handoff (7-Bucket-Brief)";

/** True for a handoff-brief head - the stable key OR the legacy German title (pre-i18n ledgers).
 *  Used for supersession/re-injection matching and for friendly display labeling. */
export function isHandoffHead(decision: string): boolean {
  return decision === HANDOFF_DECISION_KEY || decision === LEGACY_HANDOFF_TITLE_DE;
}

/** Calibration baseline: the German 7-bucket prompt (keeps golden-set numbers stable). */
export const SEVEN_BUCKET_PROMPT = messages.de.prompts.sevenBucket;
