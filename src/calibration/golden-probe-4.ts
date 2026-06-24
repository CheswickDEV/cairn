/**
 * Cairn — golden-set probe #4 (ADR-0005). Domain: Zero-Downtime-DB-Migration (Postgres → sharded,
 * expand/contract). Supersession-lastig. Gleiche Fallen-Struktur (primacy / supersession /
 * verbatim / buried / recency). Konzis, kein Padding.
 */

import type { GroundTruth } from "./ground-truth.js";

const EXPAND_DDL = `-- expand-Phase: additiv, abwärtskompatibel
ALTER TABLE orders ADD COLUMN shard_key int;
CREATE INDEX CONCURRENTLY idx_orders_user_id_created
  ON orders (user_id, created_at);`;

const SHARD_CFG = `sharding:
  strategy: hash
  key: user_id
  shards: 16
  backfill_batch_rows: 5000   # gedrosselt, nie full-table`;

export const GOLDEN4_GROUND_TRUTH: GroundTruth = {
  weights: { recall: 0.4, hallucination: 0.3, supersession: 0.15, verbatim: 0.15 },
  mustSurvive: [
    { id: "g4_c_zero", kind: "constraint", primacy: true, sourceRef: "D01", text: "Zero-Downtime ist Pflicht; kein Write-Lock > 1 s auf Hot-Tables." },
    { id: "g4_c_compat", kind: "constraint", primacy: true, sourceRef: "D01", text: "Alte und neue App-Version müssen parallel laufen (expand/contract)." },
    { id: "g4_d_mode0", kind: "decision", status: "superseded", supersededBy: "g4_d_mode1", sourceRef: "D02", text: "Big-Bang-Offline-Migration im Wartungsfenster (initialer Ansatz)." },
    { id: "g4_d_mode1", kind: "decision", status: "accepted", supersedes: "g4_d_mode0", sourceRef: "D03", text: "Online-Migration per expand/contract." },
    { id: "g4_d_sync0", kind: "decision", status: "discarded", sourceRef: "D04", text: "App-seitiges Dual-Write vorgeschlagen, verworfen (fehleranfällig)." },
    { id: "g4_d_sync1", kind: "decision", status: "accepted", sourceRef: "D04", text: "CDC via logical replication (Debezium) für den Sync." },
    { id: "g4_d_shard", kind: "decision", status: "discarded", sourceRef: "D05", text: "Range-Sharding verworfen (Hotspots); Hash-Sharding auf user_id gewählt." },
    { id: "g4_v_ddl", kind: "verbatim", exact: true, sourceRef: "D06", text: EXPAND_DDL },
    { id: "g4_v_cfg", kind: "verbatim", exact: true, sourceRef: "D07", text: SHARD_CFG },
    { id: "g4_v_idx", kind: "verbatim", exact: true, sourceRef: "D06", text: "idx_orders_user_id_created" },
    { id: "g4_v_slot", kind: "verbatim", exact: true, sourceRef: "D08", text: "pg_create_logical_replication_slot" },
    { id: "g4_cc_backfill", kind: "critical_context", buried: true, sourceRef: "D07", text: "Backfill MUSS gebatcht + gedrosselt laufen (5000 Zeilen); ein ungebatchter UPDATE hat die Tabelle einmal gelockt (Incident). Nicht ändern." },
    { id: "g4_n_rows", kind: "number", sourceRef: "D09", text: "Tabelle orders ~2,3 Mrd Zeilen." },
    { id: "g4_n_p99", kind: "number", sourceRef: "D09", text: "p99-Latenz-Budget = 50 ms; 16 Shards." },
    { id: "g4_o_drop", kind: "open_decision", sourceRef: "D10", text: "OFFEN: ob die Alt-Tabellen nach Cutover sofort gedroppt oder 30 Tage behalten werden — noch nicht entschieden." },
    { id: "g4_r_next", kind: "recency", sourceRef: "D11", text: "Nächster Schritt: Shadow-Reads gegen beide Stores vergleichen (Konsistenz-Check) vor dem Cutover." },
  ],
  mustNotAppear: [
    "Big-Bang-Offline-Migration als gewählter Weg.",
    "Range-Sharding als gewählte Strategie.",
    "App-seitiges Dual-Write als finale Sync-Lösung.",
    "Write-Lock über 1 s ist akzeptabel.",
    "Eine konkrete Postgres-Versionsnummer.",
  ],
};

export const GOLDEN4_PROBE = [
  "# DB — Zero-Downtime-Migration → Sharding",
  "",
  "[D01] Iris: Zwei harte Vorgaben: (1) **Zero-Downtime**, kein **Write-Lock > 1 s** auf Hot-Tables. " +
    "(2) Alte und neue App-Version müssen **parallel laufen** (expand/contract). Jede Entscheidung dagegen prüfen.",
  "[D02] Paul: Ich würde **Big-Bang im Wartungsfenster** offline migrieren.",
  "[D03] Iris: Wartungsfenster ist nicht drin (Zero-Downtime). Korrektur: **online, expand/contract**. Big-Bang ist raus.",
  "[D04] Paul: Sync alt→neu per **Dual-Write** in der App? Iris: Zu fehleranfällig — **CDC via logical replication (Debezium)**. Dual-Write verworfen.",
  "[D05] Paul: Sharding: **Range** auf created_at? Iris: Hotspots — **verworfen**. **Hash-Sharding auf user_id**.",
  "[D06] Paul: DDL der expand-Phase:",
  "```sql",
  EXPAND_DDL,
  "```",
  "[D07] Iris: Shard-Config (WICHTIG: Backfill **gebatcht/gedrosselt, 5000 Zeilen** — ein full-table-UPDATE hat uns die Tabelle gelockt):",
  "```yaml",
  SHARD_CFG,
  "```",
  "[D08] Paul: Replikations-Slot lege ich mit `pg_create_logical_replication_slot` an.",
  "[D09] Paul: Größenordnung: orders **~2,3 Mrd Zeilen**, p99-Budget **50 ms**, **16 Shards**.",
  "[D10] Iris: OFFEN: ob wir die Alt-Tabellen nach Cutover sofort droppen oder 30 Tage behalten — noch offen.",
  "[D11] Iris: **Nächster Schritt:** Shadow-Reads gegen beide Stores vergleichen (Konsistenz) vor dem Cutover.",
].join("\n");

export const GOLDEN4_EXACT_SPANS: string[] = GOLDEN4_GROUND_TRUTH.mustSurvive
  .filter((i) => i.exact)
  .map((i) => i.text);
