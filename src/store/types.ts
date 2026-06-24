/**
 * Cairn - Decision/Evidence store (T2, ADR-0001 local store + ADR-0002 structured memory).
 *
 * Append-only, ADR-style ledger: a decision is never hard-deleted. When a new decision
 * supersedes an old one, the old row is marked `superseded` and the two are chained via
 * `supersedes` / `superseded_by`. This is the persistent, cross-session memory the
 * `handoff` tool writes to and the `decision_log` tool reads from (T1).
 */

export type DecisionStatus = "proposed" | "accepted" | "superseded";
export type EvidenceType = "msg" | "file" | "url" | "tool_out";

export interface DecisionRow {
  decisionId: string;
  ts: string; // ISO timestamp
  who: string;
  decision: string;
  rationale: string;
  alternatives: string[]; // persisted as alternatives_json
  status: DecisionStatus;
  supersedes: string | null;
  supersededBy: string | null;
}

export interface EvidenceRow {
  evidenceId: string;
  decisionId: string;
  claim: string;
  sourceRef: string;
  type: EvidenceType;
  /** Byte-exact verbatim block (code/value/id) when the claim is a protected span; else null. */
  verbatim: string | null;
  ts: string;
}

export interface NewDecision {
  /** Optional explicit id; the store generates a uuid when omitted. */
  decisionId?: string;
  ts?: string;
  who: string;
  decision: string;
  rationale: string;
  alternatives?: string[];
  /** Defaults to "accepted". */
  status?: DecisionStatus;
  /** When set, the referenced decision is marked superseded and chained to the new one. */
  supersedes?: string | null;
}

export interface NewEvidence {
  evidenceId?: string;
  decisionId: string;
  claim: string;
  sourceRef: string;
  type: EvidenceType;
  verbatim?: string | null;
  ts?: string;
}

export interface DecisionQuery {
  status?: DecisionStatus;
  /** ISO timestamp, inclusive lower bound. */
  since?: string;
  /** ISO timestamp, inclusive upper bound. */
  until?: string;
}

/** Storage contract consumed by the T1 tools. node:sqlite is the only implementation;
 *  all SQLite access is encapsulated behind this interface so the driver can be swapped
 *  in a single file. */
export interface StoreApi {
  /** Append a decision (append-only). If `supersedes` is set, the old decision is marked
   *  `superseded` and both rows are chained. Returns the stored row. */
  appendDecision(d: NewDecision): DecisionRow;
  /** Mark `oldId` as superseded by `newId` and chain both (never deletes). */
  supersede(oldId: string, newId: string): void;
  /** Append evidence bound to a decision; verbatim blocks are stored byte-exact. */
  addEvidence(e: NewEvidence): EvidenceRow;
  getDecision(id: string): DecisionRow | null;
  queryDecisions(q?: DecisionQuery): DecisionRow[];
  getEvidence(decisionId: string): EvidenceRow[];
  /** Reconstruct the current state for a new session: accepted + still-open (proposed),
   *  never superseded. */
  currentState(): DecisionRow[];
  close(): void;
}
