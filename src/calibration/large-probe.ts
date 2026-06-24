/**
 * Cairn — high-fill stress probe (ADR-0003 context-rot test).
 *
 * A deterministically-generated ~800k-token architectural context (monolith → event-sourced CQRS
 * migration) with the same trap structure as the standard probe — primacy, supersession chains,
 * verbatim-mandatory blocks, buried critical context, recency — plus large FENCE-FREE padding so
 * `freezeVerbatim` masks only the real code blocks. Generated (not a committed 3.2 MB file) so the
 * "same basis for every model" still holds: same target → byte-identical probe.
 *
 * Candidates for an 800k run are Anthropic-only: Codex account surfaces are far below that
 * (current rollout telemetry observed 258400). Reviewers (small briefs) may be cross-ecosystem.
 */

import type { GroundTruth, GtItem } from "./ground-truth.js";

const SCHEMA = `CREATE TABLE events (
  global_seq   BIGSERIAL PRIMARY KEY,
  stream_id    UUID NOT NULL,
  version      INT  NOT NULL,
  type         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (stream_id, version)
);`;

const ENV = `EVENT_STORE_DSN=esdb://events.internal.eu:2113?tls=true
KAFKA_BROKERS=kafka-0.eu:9092,kafka-1.eu:9092,kafka-2.eu:9092
KAFKA_TOPIC=orders
KAFKA_PARTITIONS=24
KAFKA_RETENTION_DAYS=30
PROJECTION_DSN=postgres://proj:****@pg-read.eu:5432/projections
REGION=eu-central-1
TZ=UTC
SNAPSHOT_EVERY=0`;

const PROJ_FN = `def apply_event(projection, event):
    # optimistic concurrency: refuse out-of-order / double apply
    if event.version != projection.version + 1:
        raise ConcurrencyError(
            f"expected version {projection.version + 1} but stream was at {event.version}")
    projection.apply(event)
    projection.version = event.version
    return projection`;

/** The curated scoring key for the large probe (~25 must_survive / 8 traps). */
export const LARGE_GROUND_TRUTH: GroundTruth = {
  weights: { recall: 0.4, hallucination: 0.3, supersession: 0.15, verbatim: 0.15 },
  mustSurvive: [
    // primacy constraints (stated first, decisive late)
    { id: "lc_eu", kind: "constraint", primacy: true, sourceRef: "T01", text: "Alle Event-Daten und Projektionen müssen in der EU bleiben (DSGVO); keine US-Region." },
    { id: "lc_zero", kind: "constraint", primacy: true, sourceRef: "T01", text: "Die Migration MUSS zero-downtime sein; kein Wartungsfenster erlaubt." },
    { id: "lc_p99", kind: "constraint", sourceRef: "T01", text: "Lese-SLA: p99 < 200 ms für Projektions-Queries." },
    { id: "lc_audit", kind: "constraint", sourceRef: "T01", text: "Append-only Audit-Log ist Compliance-Pflicht (WORM, unveränderlich)." },
    // supersession chains
    { id: "ld_db0", kind: "decision", status: "superseded", supersededBy: "ld_db1", sourceRef: "T03", text: "Single PostgreSQL für Events und Projektionen (initialer Ansatz)." },
    { id: "ld_db1", kind: "decision", status: "accepted", supersedes: "ld_db0", sourceRef: "T06", text: "Getrennt: EventStoreDB für den Event-Store, PostgreSQL nur für Read-Projektionen." },
    { id: "ld_bus0", kind: "decision", status: "discarded", sourceRef: "T08", text: "RabbitMQ als Event-Bus (vorgeschlagen, verworfen)." },
    { id: "ld_bus1", kind: "decision", status: "accepted", supersedes: "ld_bus0", sourceRef: "T09", text: "Apache Kafka als Event-Bus (Replay, Retention, Ordering pro Partition)." },
    { id: "ld_snap", kind: "decision", status: "discarded", sourceRef: "T12", text: "Snapshots alle 100 Events (vorgeschlagen, vorerst verworfen)." },
    { id: "ld_deploy", kind: "decision", status: "accepted", sourceRef: "T20", text: "Deployment auf Kubernetes (EKS-EU, eu-central-1), Blue-Green." },
    // verbatim
    { id: "lv_schema", kind: "verbatim", exact: true, sourceRef: "T05", text: SCHEMA },
    { id: "lv_env", kind: "verbatim", exact: true, sourceRef: "T14", text: ENV },
    { id: "lv_proj", kind: "verbatim", exact: true, sourceRef: "T11", text: PROJ_FN },
    { id: "lv_commit", kind: "verbatim", exact: true, sourceRef: "T21", text: "e7b1d40" },
    { id: "lv_url", kind: "verbatim", exact: true, sourceRef: "T14", text: "esdb://events.internal.eu:2113" },
    { id: "lv_error", kind: "verbatim", exact: true, sourceRef: "T10", text: "ConcurrencyError: expected version 41 but stream was at 43" },
    // numbers
    { id: "ln_tput", kind: "number", sourceRef: "T21", text: "Peak-Durchsatz ≈ 12.000 Events/Sekunde." },
    { id: "ln_p99", kind: "number", sourceRef: "T21", text: "Projektions-p99 aktuell 140 ms (unter dem 200-ms-SLA)." },
    { id: "ln_ret", kind: "number", sourceRef: "T14", text: "Kafka-Retention = 30 Tage." },
    { id: "ln_part", kind: "number", sourceRef: "T14", text: "Topic 'orders' hat 24 Partitionen." },
    // buried critical context (middle of the haystack)
    { id: "lcc_lock", kind: "critical_context", buried: true, sourceRef: "T10", text: "Aggregate MUSS optimistic-locked sein (Version-Check vor Apply); ein früheres Race führte zu Double-Apply. Nicht entfernen." },
    { id: "lcc_utc", kind: "critical_context", buried: true, sourceRef: "T10", text: "Alle Event-Timestamps in UTC; lokale Zeitzonen führten zu falscher Event-Ordering." },
    { id: "lcc_idem", kind: "critical_context", buried: true, sourceRef: "T11", text: "Consumer müssen idempotent sein (Kafka liefert at-least-once)." },
    // open decisions
    { id: "lo_snap", kind: "open_decision", sourceRef: "T22", text: "OFFEN: Snapshotting-Strategie (alle N Events vs. zeitbasiert) — noch nicht entschieden." },
    { id: "lo_split", kind: "open_decision", sourceRef: "T23", text: "OFFEN: ob der 'billing'-Context in einen eigenen Service gesplittet wird — hängt an der Lastmessung." },
    // recency
    { id: "lr_next", kind: "recency", sourceRef: "T24", text: "Nächster Schritt (zuletzt): Kafka-Consumer-Lag-Monitoring aufsetzen, einen Replay-Test über 1 Tag Produktivlast fahren und p99 erneut messen." },
  ],
  mustNotAppear: [
    "Single PostgreSQL als finale Event-Store-Lösung.",
    "RabbitMQ als gewählter/genutzter Event-Bus.",
    "US-Region oder us-east-1 für Event-Daten.",
    "Geplantes Wartungsfenster / Downtime für die Migration.",
    "Snapshotting ist bereits implementiert/entschieden.",
    "Eine konkrete Kafka- oder EventStoreDB-Versionsnummer.",
    "Optimistic Locking wurde entfernt / ist optional.",
    "Event-Timestamps in lokaler Zeitzone.",
  ],
};

const LARGE_EXACT_SPANS: string[] = LARGE_GROUND_TRUTH.mustSurvive
  .filter((i: GtItem) => i.exact)
  .map((i) => i.text);

/* ---- core transcript (the scored items live here; padding goes between blocks) ---- */

const CORE_INTRO = [
  "# Projekt ORDERS-CQRS — Migration Monolith → event-sourced CQRS-Plattform",
  "",
  "[T01] Lena (Architektin): Kickoff. Vier harte, für ALLES bindende Rahmenbedingungen: " +
    "(1) Alle Event-Daten und Projektionen müssen DSGVO-konform in der EU bleiben — keine US-Region. " +
    "(2) Die Migration MUSS zero-downtime sein; kein Wartungsfenster erlaubt. " +
    "(3) Lese-SLA: p99 < 200 ms für Projektions-Queries. " +
    "(4) Append-only Audit-Log ist Compliance-Pflicht (WORM, unveränderlich). Jede spätere Entscheidung dagegen prüfen.",
  "[T02] Tomas (Backend): Verstanden. Wir bauen Event-Sourcing + CQRS; Commands schreiben Events, Projektionen bauen Read-Models.",
  "[T03] Tomas: Für den Start nehme ich erstmal eine Single-PostgreSQL für Events UND Projektionen — weniger Infra.",
  "[T04] Mara (Data): Ok fürs Prototyping, aber unter Last koppelt das Write- und Read-Pfad.",
  "[T05] Tomas: Event-Tabelle (Append-only, unique pro stream/version):",
  "```sql",
  SCHEMA,
  "```",
  "[T06] Mara: Genau wie befürchtet — die Single-PG hält die p99 (Bedingung 3) unter Last nicht. " +
    "Korrektur: wir trennen. **EventStoreDB für den Event-Store, PostgreSQL nur für Read-Projektionen.** Single-PG ist raus.",
  "[T07] Lena: Einverstanden. Damit ist der Audit-Log (Bedingung 4) im Event-Store nativ append-only.",
].join("\n");

const CORE_MID = [
  "[T08] Tomas: Event-Bus — Vorschlag RabbitMQ.",
  "[T09] Mara: RabbitMQ kann kein langzeit-Replay/Retention und keine partitionierte Ordering. Verworfen. " +
    "Wir nehmen **Apache Kafka** (Replay, Retention, Ordering pro Partition). Kafka ist gesetzt, RabbitMQ ist raus.",
  "[T10] Mara: WICHTIG, sonst stille Datenfehler: das Aggregate MUSS optimistic-locked sein (Version-Check vor Apply). " +
    "Ein früheres Race hat zu Double-Apply geführt — der Fehler war: `ConcurrencyError: expected version 41 but stream was at 43`. " +
    "Außerdem: alle Event-Timestamps in UTC (lokale Zeitzonen brachten falsche Event-Ordering). Beides nicht zurückdrehen.",
  "[T11] Tomas: Projektions-Apply mit Version-Check (Consumer sind idempotent, weil Kafka at-least-once liefert):",
  "```python",
  PROJ_FN,
  "```",
  "[T12] Tomas: Snapshots alle 100 Events? — Vorgeschlagen, aber vorerst **verworfen** (erst messen).",
  "[T13] Lena: Ok. Kein Snapshotting jetzt.",
].join("\n");

const CORE_LATE = [
  "[T14] Tomas: Aktuelle `.env` (exakt so übernehmen):",
  "```",
  ENV,
  "```",
  "Der Event-Store läuft unter esdb://events.internal.eu:2113; Topic 'orders' hat 24 Partitionen, Kafka-Retention = 30 Tage.",
  "[T20] Tomas: Deployment steht: **Kubernetes (EKS-EU, eu-central-1), Blue-Green** — passt zu Bedingung 1 (EU).",
  "[T21] Tomas: Live. Commit `e7b1d40` ist deployed. Peak-Durchsatz ≈ 12.000 Events/Sekunde, " +
    "Projektions-p99 aktuell 140 ms — unter dem 200-ms-SLA. ✅",
  "[T22] Mara: OFFEN: Snapshotting-Strategie (alle N Events vs. zeitbasiert) — noch nicht entschieden.",
  "[T23] Tomas: OFFEN: ob der 'billing'-Context in einen eigenen Service gesplittet wird — hängt an der Lastmessung.",
  "[T24] Lena: Stand gut. **Nächster Schritt — bitte als Nächstes:** Kafka-Consumer-Lag-Monitoring aufsetzen, " +
    "einen Replay-Test über 1 Tag Produktivlast fahren und p99 erneut messen.",
].join("\n");

/** Deterministic, fence-free padding (realistic CI/log/discarded-spike noise). */
function padBlock(prefix: string, startIdx: number, chars: number): string {
  const out: string[] = [];
  let len = 0;
  let i = startIdx;
  while (len < chars) {
    const line =
      `[${prefix}${i}] Build #${10000 + i}: stage 'integration' passed in ${20 + (i % 40)}s, ` +
      `${100 + (i % 900)} specs green, 0 failures. Spike variant-${i % 13}: measured p99 ${120 + (i % 180)}ms ` +
      `over ${1 + (i % 9)} runs — rejected (over budget). Discarded: approach ${i % 17} would couple read/write paths; ` +
      `see runbook section ${i % 23}. No schema change. Telemetry: queue depth ${i % 500}, consumer lag ${i % 60}s, retries ${i % 7}.`;
    out.push(line);
    len += line.length + 1;
    i++;
  }
  return out.join("\n");
}

/** Build the ~targetTokens probe (deterministic). primacy first, buried in the middle, recency last. */
export function buildLargeProbe(targetTokens = 800_000): { probe: string; exactSpans: string[] } {
  const targetChars = targetTokens * 4;
  const coreLen = CORE_INTRO.length + CORE_MID.length + CORE_LATE.length;
  const padTotal = Math.max(0, targetChars - coreLen);
  const half = Math.floor(padTotal / 2);
  const pad1 = padBlock("P", 0, half);
  const pad2 = padBlock("Q", 1_000_000, padTotal - half);
  const probe = [CORE_INTRO, pad1, CORE_MID, pad2, CORE_LATE].join("\n\n");
  return { probe, exactSpans: LARGE_EXACT_SPANS };
}
