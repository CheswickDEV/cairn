/**
 * Cairn - SQLite implementation of the Decision/Evidence store (T2).
 *
 * Uses Node's built-in `node:sqlite` (DatabaseSync) - chosen for zero-native-build
 * self-install robustness (requires Node >= 22). ALL SQLite access lives in this single
 * module so the driver is swappable in one file (the rest of the app sees only StoreApi).
 *
 * Append-only invariant: there is NO DELETE statement in this file. Supersession only
 * updates the `status` / `superseded_by` columns of the old row; the row itself survives.
 */

import "../core/suppress-experimental-warning.js"; // installs the emitWarning filter (runs before the require below)
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncInstance } from "node:sqlite"; // type-only: erased at compile, no runtime load
import { randomUUID } from "node:crypto";
import type {
  DecisionQuery,
  DecisionRow,
  DecisionStatus,
  EvidenceRow,
  NewDecision,
  NewEvidence,
  StoreApi,
} from "./types.js";

// node:sqlite is loaded via require (not a static `import`) on purpose: a static import resolves
// during the ESM link phase - before ANY module body runs - so the suppressor above couldn't install
// its filter in time and the experimental warning would slip through. require() loads it during this
// module's evaluation, after the suppressor has run.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const DDL = `
CREATE TABLE IF NOT EXISTS decisions (
  decision_id        TEXT PRIMARY KEY,
  ts                 TEXT NOT NULL,
  who                TEXT NOT NULL,
  decision           TEXT NOT NULL,
  rationale          TEXT NOT NULL,
  alternatives_json  TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL CHECK (status IN ('proposed','accepted','superseded')),
  supersedes         TEXT,
  superseded_by      TEXT
);

CREATE TABLE IF NOT EXISTS evidence (
  evidence_id  TEXT PRIMARY KEY,
  decision_id  TEXT NOT NULL,
  claim        TEXT NOT NULL,
  source_ref   TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('msg','file','url','tool_out')),
  verbatim     TEXT,
  ts           TEXT NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES decisions(decision_id)
);

CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);
CREATE INDEX IF NOT EXISTS idx_decisions_ts     ON decisions(ts);
CREATE INDEX IF NOT EXISTS idx_evidence_decision ON evidence(decision_id);
`;

/** Raw row shapes as returned by node:sqlite (snake_case columns). */
interface DecisionDbRow {
  decision_id: string;
  ts: string;
  who: string;
  decision: string;
  rationale: string;
  alternatives_json: string;
  status: DecisionStatus;
  supersedes: string | null;
  superseded_by: string | null;
}

interface EvidenceDbRow {
  evidence_id: string;
  decision_id: string;
  claim: string;
  source_ref: string;
  type: EvidenceRow["type"];
  verbatim: string | null;
  ts: string;
}

function mapDecision(r: DecisionDbRow): DecisionRow {
  let alternatives: string[] = [];
  try {
    const parsed = JSON.parse(r.alternatives_json);
    if (Array.isArray(parsed)) alternatives = parsed.map((x) => String(x));
  } catch {
    alternatives = [];
  }
  return {
    decisionId: r.decision_id,
    ts: r.ts,
    who: r.who,
    decision: r.decision,
    rationale: r.rationale,
    alternatives,
    status: r.status,
    supersedes: r.supersedes,
    supersededBy: r.superseded_by,
  };
}

function mapEvidence(r: EvidenceDbRow): EvidenceRow {
  return {
    evidenceId: r.evidence_id,
    decisionId: r.decision_id,
    claim: r.claim,
    sourceRef: r.source_ref,
    type: r.type,
    verbatim: r.verbatim,
    ts: r.ts,
  };
}

export interface SqliteStoreOptions {
  /** File path or ":memory:" (default). The MCP server passes a real path; tests use memory. */
  path?: string;
  /** Injectable clock for reproducible timestamps in tests. */
  now?: () => string;
}

export class SqliteStore implements StoreApi {
  private readonly db: DatabaseSyncInstance;
  private readonly now: () => string;

  constructor(opts: SqliteStoreOptions = {}) {
    this.db = new DatabaseSync(opts.path ?? ":memory:");
    this.now = opts.now ?? (() => new Date().toISOString());
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(DDL);
  }

  appendDecision(d: NewDecision): DecisionRow {
    const row: DecisionRow = {
      decisionId: d.decisionId ?? randomUUID(),
      ts: d.ts ?? this.now(),
      who: d.who,
      decision: d.decision,
      rationale: d.rationale,
      alternatives: d.alternatives ?? [],
      status: d.status ?? "accepted",
      supersedes: d.supersedes ?? null,
      supersededBy: null,
    };

    this.db
      .prepare(
        `INSERT INTO decisions
           (decision_id, ts, who, decision, rationale, alternatives_json, status, supersedes, superseded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.decisionId,
        row.ts,
        row.who,
        row.decision,
        row.rationale,
        JSON.stringify(row.alternatives),
        row.status,
        row.supersedes,
        row.supersededBy,
      );

    // Atomic supersession: marking the predecessor keeps it (no delete) and chains both.
    if (row.supersedes) this.supersede(row.supersedes, row.decisionId);

    return row;
  }

  supersede(oldId: string, newId: string): void {
    // Update only status + back-link on the OLD row. The row is preserved (append-only).
    this.db
      .prepare(`UPDATE decisions SET status = 'superseded', superseded_by = ? WHERE decision_id = ?`)
      .run(newId, oldId);
    // Ensure the new row records what it supersedes (idempotent if already set).
    this.db
      .prepare(`UPDATE decisions SET supersedes = ? WHERE decision_id = ?`)
      .run(oldId, newId);
  }

  addEvidence(e: NewEvidence): EvidenceRow {
    const row: EvidenceRow = {
      evidenceId: e.evidenceId ?? randomUUID(),
      decisionId: e.decisionId,
      claim: e.claim,
      sourceRef: e.sourceRef,
      type: e.type,
      verbatim: e.verbatim ?? null,
      ts: e.ts ?? this.now(),
    };

    this.db
      .prepare(
        `INSERT INTO evidence (evidence_id, decision_id, claim, source_ref, type, verbatim, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.evidenceId, row.decisionId, row.claim, row.sourceRef, row.type, row.verbatim, row.ts);

    return row;
  }

  getDecision(id: string): DecisionRow | null {
    const r = this.db.prepare(`SELECT * FROM decisions WHERE decision_id = ?`).get(id) as
      | DecisionDbRow
      | undefined;
    return r ? mapDecision(r) : null;
  }

  queryDecisions(q: DecisionQuery = {}): DecisionRow[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (q.status) {
      clauses.push("status = ?");
      params.push(q.status);
    }
    if (q.since) {
      clauses.push("ts >= ?");
      params.push(q.since);
    }
    if (q.until) {
      clauses.push("ts <= ?");
      params.push(q.until);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM decisions ${where} ORDER BY ts ASC, decision_id ASC`)
      .all(...params) as unknown as DecisionDbRow[];
    return rows.map(mapDecision);
  }

  getEvidence(decisionId: string): EvidenceRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM evidence WHERE decision_id = ? ORDER BY ts ASC, evidence_id ASC`)
      .all(decisionId) as unknown as EvidenceDbRow[];
    return rows.map(mapEvidence);
  }

  currentState(): DecisionRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM decisions WHERE status IN ('accepted','proposed') ORDER BY ts ASC, decision_id ASC`,
      )
      .all() as unknown as DecisionDbRow[];
    return rows.map(mapDecision);
  }

  close(): void {
    this.db.close();
  }
}
