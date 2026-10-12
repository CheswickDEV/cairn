import { describe, it, expect } from "vitest";
import { matchesKeys, normalizeForKeys, missingMustSurvive } from "./review.js";
import { goldenProbes } from "./golden-set.js";
import { LARGE_GROUND_TRUTH } from "./large-probe.js";

/* ADR-0012: non-exact must-survive items are checked by their key facts, not by the whole sentence. */

const SETS = [...goldenProbes().map((g) => [g.label, g.groundTruth] as const), ["large", LARGE_GROUND_TRUTH] as const];
const ITEMS = SETS.flatMap(([label, gt]) => gt.mustSurvive.filter((i) => !i.exact).map((i) => [`${label}/${i.id}`, i] as const));

describe("key facts of the ground truths", () => {
  it("every non-exact item has keys (5 golden probes + the high-fill probe: 89 items)", () => {
    expect(ITEMS).toHaveLength(89);
    for (const [, it] of ITEMS) expect(it.keys?.length).toBeGreaterThan(0);
  });

  it.each(ITEMS)("%s: its own text carries its keys", (_, it) => {
    expect(matchesKeys(it.text, it.keys!)).toBe(true);
  });

  it("no key has a `*` inside (only a leading or trailing one lifts a boundary)", () => {
    const inner = ITEMS.flatMap(([ref, it]) => it.keys!.flat().filter((k) => k.slice(1, -1).includes("*")).map((k) => `${ref}: ${k}`));
    expect(inner).toEqual([]);
  });

  it("a brief skeleton (bucket headings only) carries no item", () => {
    const skeleton = "1) DECISIONS\n2) EVIDENCE\n3) OPEN QUESTIONS\n4) CONSTRAINTS\n5) VERBATIM\n6) NEXT STEPS\n7) DISCARDED\n";
    for (const [, gt] of SETS) {
      const nonExact = gt.mustSurvive.filter((i) => !i.exact).map((i) => i.id);
      expect(missingMustSurvive(skeleton, gt).filter((id) => nonExact.includes(id))).toEqual(nonExact);
    }
  });
});

describe("key matching", () => {
  it("respects word boundaries on alphanumeric edges", () => {
    expect(matchesKeys("Daten bleiben in der EU.", [["eu"]])).toBe(true);
    expect(matchesKeys("EU-Verarbeitung", [["eu"]])).toBe(true);
    expect(matchesKeys("eine neue Euro-Grenze", [["eu"]])).toBe(false);
    expect(matchesKeys("1240 Belege", [["240"]])).toBe(false);
  });

  it("a trailing or leading * lifts the boundary on that side", () => {
    expect(matchesKeys("Partitionen", [["partition*"]])).toBe(true);
    expect(matchesKeys("Partitionen", [["partition"]])).toBe(false);
    expect(matchesKeys("gesharded", [["*shard*"]])).toBe(true);
    expect(matchesKeys("gesharded", [["shard*"]])).toBe(false);
  });

  it("all groups must match, any alternative within a group", () => {
    expect(matchesKeys("Budget 400 €", [["400"], ["€", "eur"]])).toBe(true);
    expect(matchesKeys("Budget 400 EUR", [["400"], ["€", "eur"]])).toBe(true);
    expect(matchesKeys("Budget 400", [["400"], ["€", "eur"]])).toBe(false);
  });

  it("ends a number where the key ends: no further digits, no attached unit unless the key lists it", () => {
    expect(matchesKeys("p95 < 1.8 s", [["1.8"]])).toBe(true);
    expect(matchesKeys("p95 < 1.8s", [["1.8"]])).toBe(false);
    expect(matchesKeys("p95 < 1.8s", [["1.8s"]])).toBe(true);
    for (const text of ["400k events", "2.3M rows", "16GiB RAM", "240ms", "32GB"]) {
      expect(matchesKeys(text, [["400", "2.3", "16", "240", "32"]])).toBe(false);
    }
    expect(matchesKeys("Limit 4GiB", [["4gi*"]])).toBe(true);
    expect(matchesKeys("a 30-day TTL", [["30-day*"]])).toBe(true);
    expect(matchesKeys("Budget 400 €/Monat", [["400"]])).toBe(true);
    expect(matchesKeys("Hit-Rate 87%", [["87"]])).toBe(true);
    expect(matchesKeys("p95 1.85 s", [["1.8"]])).toBe(false);
    expect(matchesKeys("2400 Belege", [["240"]])).toBe(false);
    expect(matchesKeys("12.5 ms", [["12"]])).toBe(false);
  });

  it("does not read an identifier that goes on with _ as the word", () => {
    expect(matchesKeys("POSTGRES_PASSWORD steht in der .env", [["postgres"]])).toBe(false);
    expect(matchesKeys("MAX_BATCH=32", [["max_batch"], ["32"]])).toBe(true);
  });

  it("does not read a URL scheme as the word", () => {
    expect(matchesKeys("DB_DSN=postgres://beleg@localhost/beleg_prod", [["postgres"]])).toBe(false);
    expect(matchesKeys("broker at redis://localhost:6379/0", [["redis"]])).toBe(false);
    expect(matchesKeys("REDIS_URL=redis://localhost:6379/0", [["redis"]])).toBe(false); // an identifier and a scheme
    expect(matchesKeys("Postgres replaced SQLite", [["postgres"]])).toBe(true);
    expect(matchesKeys("Redis: queue", [["redis"]])).toBe(true);
  });

  it.each([
    ["ocr-beleg", "c_sla", "SLA: p95 below 1.8s per receipt", true],
    ["ocr-beleg", "c_eu", "Let us keep the data in the EU.", false], // the pronoun is no US exclusion
    ["ocr-beleg", "c_eu", "Data stays in the EU, no US cloud.", true],
    ["ocr-beleg", "o_worker", "OPEN: another worker once volume grows", true],
    ["api-gateway", "g2_c_stale", "the cache may be stale for one minute at most", true],
    ["oauth-token", "g3_n_refresh", "refresh tokens live for a 30-day TTL", true],
    ["db-migration", "g4_c_zero", "migration without downtime, no write lock over 1 s", true],
    ["db-migration", "g4_n_p99", "p99 budget 50 Millisekunden across 16 shards", true],
    ["k8s-rollout", "g5_n_replicas", "six replicas, memory limit 4GiB", true],
    ["k8s-rollout", "g5_d_tag0", "use the latest docs", false],
  ] as const)("%s/%s: %s → %s", (label, id, text, expected) => {
    const gt = SETS.find(([l]) => l === label)![1];
    const it = gt.mustSurvive.find((i) => i.id === id)!;
    expect(matchesKeys(text, it.keys!)).toBe(expected);
  });

  // Paraphrases and look-alikes from the review of the key rules (S23-A/B, 2026-10-12): the expected value
  // says whether the text really carries the fact.
  it.each([
    ["ocr-beleg/c_eu", "Receipt data must stay in the EU (GDPR); no processing in US clouds.", true],
    ["ocr-beleg/c_eu", "Belegdaten bleiben DSGVO-konform in der EU, keine Verarbeitung in US-Clouds.", true],
    ["ocr-beleg/c_eu", "GDPR: data stays in the EU; US-hosted OCR is ruled out.", true],
    ["ocr-beleg/c_sla", "Latency SLA: 95th percentile below 1.8 s per receipt.", true],
    ["ocr-beleg/d_db_1", "DB: Postgres (SQLite locked under concurrent worker writes).", true],
    ["ocr-beleg/d_db_1", "Wechsel auf Postgres, weil SQLite bei parallelen Writes lockt.", true],
    ["ocr-beleg/d_ocr_doctr", "OCR engine: docTR, running on our own VPS (correct ä/ö/ü).", true],
    ["ocr-beleg/n_throughput", "Throughput about 240 receipts/hr.", true],
    ["ocr-beleg/cc_umlaut", "docTR was picked because it gets ä/ö/ü right; PaddleOCR did not.", true],
    ["ocr-beleg/o_worker", "OPEN: a 2nd worker once volume grows (depends on next week's load test).", true],
    ["ocr-beleg/o_worker", "OFFEN: 2. Worker bei steigendem Volumen, hängt an der Lastmessung.", true],
    ["ocr-beleg/o_worker", "OPEN: scale to two workers if volume rises.", true],
    ["api-gateway/g2_d_store0", "Initially local counters on each instance (superseded).", true],
    ["api-gateway/g2_n_p95", "Gateway p95 is 12 msec.", true],
    ["oauth-token/g3_n_refresh", "Refresh tokens expire after one month.", true],
    ["oauth-token/g3_n_rot", "Signing keys rotate quarterly.", true],
    ["db-migration/g4_c_compat", "Old and new app versions must coexist (expand/contract).", true],
    ["db-migration/g4_c_compat", "Both app versions have to run concurrently during the migration.", true],
    ["db-migration/g4_o_drop", "OPEN: drop the old tables right after cutover or retain them for a month.", true],
    ["k8s-rollout/g5_c_zero", "Rollout must be zero-downtime: maxUnavailable set to 0.", true],
    ["k8s-rollout/g5_c_zero", "Zero-downtime rollout, maxUnavailable must be 0.", true],
    ["k8s-rollout/g5_d_tag0", "The `latest` tag was proposed and rejected (not reproducible).", true],
    ["k8s-rollout/g5_n_replicas", "replica count 6, memory limit 4Gi.", true],
    ["k8s-rollout/g5_n_replicas", "Replicas 6; Memory-Limit 4 GiB.", true],
    ["k8s-rollout/g5_n_pdb", "PDB with minAvailable set to 5.", true],
    ["large/ln_tput", "Peak throughput: twelve thousand events per second.", true],
    ["large/lc_eu", "All event data stays in the EU (GDPR); no US regions.", true],
    ["ocr-beleg/c_budget", "Kosten ≈ 290 €/Monat (unter 400er-Deckel).", false],
    ["ocr-beleg/c_budget", "OCR p95 400ms; costs 290 € per month.", false],
    ["ocr-beleg/r_next", "DECIDE: threshold 0.82 vs 0.78. SLA p95 < 1.8 s. DB_DSN=postgres://beleg@localhost/beleg_prod", false],
    ["large/ln_part", "Replay test over 24h of production load; ordering per partition.", false],
    ["ocr-beleg/n_throughput", "Batch latency 240ms per hour of load.", false],
    ["ocr-beleg/n_batch", "VPS has 32GB RAM; batch jobs via Redis.", false],
    ["db-migration/g4_n_p99", "p99 budget 50 ms; nodes have 16GB RAM.", false],
    ["api-gateway/g2_c_burst", "Rate limit token bucket, burst handling; p99 100ms, HTTP 200s.", false],
    ["ocr-beleg/c_budget", "Budget 400 (currency unknown); timezone Europe/Berlin.", false],
    ["ocr-beleg/o_worker", "Worker runs one job per second.", false],
    ["ocr-beleg/c_eu", "Receipt data must stay in Europe (GDPR); no US regions, not even for OCR.", true],
    ["ocr-beleg/c_eu", "GDPR: data stays in the EU, no American cloud providers.", true],
    ["ocr-beleg/c_eu", "DSGVO: Daten bleiben in der EU, kein US-Hosting.", true],
    ["ocr-beleg/c_eu", "EU data residency required; processing in US data centers is not allowed.", true],
    ["ocr-beleg/c_eu", "Let us keep everything in the EU, and use the USB key.", false],
    ["ocr-beleg/c_budget", "Infra budget capped at €400/month.", true],
    ["ocr-beleg/c_budget", "Budget ceiling: four hundred euros a month.", true],
    ["ocr-beleg/c_budget", "Timezone Europe/Berlin was wrong; HTTP 400 on bad uploads.", false],
    ["ocr-beleg/c_sla", "SLA: 95th percentile latency under 1.8 s per receipt.", true],
    ["ocr-beleg/c_sla", "p95 must stay below 1800 milliseconds.", true],
    ["ocr-beleg/d_db_1", "Database: Postgres (replaced SQLite).", true],
    ["ocr-beleg/d_db_1", "We moved to Postgres because SQLite locked under concurrent writers.", true],
    ["ocr-beleg/d_ocr_doctr", "OCR: docTR, hosted on our own server, handles umlauts correctly.", true],
    ["ocr-beleg/o_worker", "OPEN: scale to two workers if volume grows; depends on next week's load test.", true],
    ["ocr-beleg/o_worker", "OFFEN: einen 2. Worker hinzunehmen, abhängig von der Lastmessung.", true],
    ["ocr-beleg/o_worker", "OPEN: add one more worker as volume grows.", true],
    ["ocr-beleg/r_next", "Next: lower the threshold to 0.78 for 24 hours of production traffic, re-measure p95, post results.", true],
    ["ocr-beleg/r_next", "Next: drop CONFIDENCE_THRESHOLD to 0.78 for a full day under real load and re-check p95.", true],
    ["ocr-beleg/r_next", "0.78 vs 0.82 open; SLA p95 < 1.8 s; DSN postgres://beleg@localhost/beleg_prod", false],
    ["api-gateway/g2_c_stale", "Cached data may be at most 60sec old (compliance).", true],
    ["api-gateway/g2_c_stale", "Cache staleness limit: sixty seconds.", true],
    ["api-gateway/g2_n_hit", "Cache hit ratio currently 87 percent.", true],
    ["api-gateway/g2_d_store0", "Initially per-instance in-memory counters.", true],
    ["oauth-token/g3_cc_skew", "Allow a clock skew of half a minute in JWT exp checks.", true],
    ["oauth-token/g3_n_refresh", "Refresh tokens expire after a month (30 days).", true],
    ["oauth-token/g3_n_refresh", "Refresh token lifetime: one month.", true],
    ["oauth-token/g3_n_rot", "Signing keys rotate quarterly (every 90 days).", true],
    ["oauth-token/g3_n_rot", "Signing keys are rotated every three months.", true],
    ["db-migration/g4_n_rows", "orders has roughly 2.3 billion rows.", true],
    ["db-migration/g4_n_rows", "orders: ~2.3B rows.", true],
    ["db-migration/g4_n_rows", "orders: about 2,300,000,000 rows.", true],
    ["db-migration/g4_n_p99", "p99 latency budget 50 ms across sixteen shards.", true],
    ["db-migration/g4_o_drop", "OPEN: drop the old tables right after cutover or keep them for a month.", true],
    ["db-migration/g4_o_drop", "OPEN: purge old tables immediately vs. retain them 30 days.", true],
    ["db-migration/g4_c_zero", "No downtime allowed; no write lock longer than 1 s on hot tables.", true],
    ["db-migration/g4_cc_backfill", "Backfill must run in batches of 5,000 rows, throttled.", true],
    ["db-migration/g4_cc_backfill", "Backfill in chunks of 5000 rows with a rate limit.", true],
    ["k8s-rollout/g5_n_replicas", "Six replicas, CPU limit 2, memory limit 4 GiB.", true],
    ["k8s-rollout/g5_n_replicas", "replica count 6; memory limit 4096Mi.", true],
    ["k8s-rollout/g5_n_pdb", "PDB keeps at least 5 pods available.", true],
    ["k8s-rollout/g5_n_pdb", "PodDisruptionBudget: minAvailable is 5.", true],
    ["k8s-rollout/g5_c_zero", "maxUnavailable must be 0 for zero downtime.", true],
    ["k8s-rollout/g5_d_tag0", "Rejected: using the `latest` tag (not reproducible).", true],
    ["k8s-rollout/g5_d_tag0", "Rejected: tagging images as 'latest'.", true],
    ["k8s-rollout/g5_cc_delay", "initialDelaySeconds must be at least 45 seconds (JVM warm-up).", true],
    ["k8s-rollout/g5_cc_delay", "Readiness delay ≥ 45s because the JVM needs to warm up.", true],
    ["k8s-rollout/g5_d_kind0", "Started with a stateless Deployment, then switched to a StatefulSet.", true],
    ["large/ln_part", "Kafka replay test over 24h; ordering per partition.", false],
    ["large/ln_part", "Topic orders has 24 partitions.", true],
    ["large/lc_eu", "All event data must remain within the EU (GDPR); US regions are excluded.", true],
    ["large/lo_snap", "OPEN: snapshot every N events or on a timer.", true],
    ["large/lo_snap", "OPEN: snapshot by event count or periodically.", true],
    // Second review round (r1-A/B on 2de9308): German worker forms, look-alikes of the widened keys.
    ["ocr-beleg/o_worker", "OFFEN: einen weiteren Worker hinzunehmen, je nach Lastmessung.", true],
    ["ocr-beleg/o_worker", "OFFEN: zusätzlicher Worker bei mehr Volumen.", true],
    ["ocr-beleg/o_worker", "OFFEN: zusätzliche Worker, wenn das Volumen steigt.", true],
    ["ocr-beleg/o_worker", "OFFEN: noch einen Worker dazunehmen.", true],
    ["ocr-beleg/o_worker", "OFFEN: weitere Worker nach der Lastmessung.", true],
    ["ocr-beleg/c_eu", "EU-Kunden zahlen mit American Express.", false],
    ["ocr-beleg/c_eu", "EU customers and American customers share one login.", false],
    ["ocr-beleg/d_db_1", "POSTGRES_PASSWORD steht in der .env, die DB ist noch SQLite.", false],
    ["oauth-token/g3_n_refresh", "Refresh tokens rotate; review the dashboard again in a month.", false],
    ["oauth-token/g3_n_rot", "Refresh-Token-Rotation ist Pflicht; quarterly review of the scopes.", false],
    ["db-migration/g4_o_drop", "Drop the cache warm-up; look at it again in a month.", false],
    ["k8s-rollout/g5_d_tag0", "The `latest` digest is pinned by sha256.", false],
    ["k8s-rollout/g5_n_pdb", "At least 5 pods are scheduled per node.", false],
    ["api-gateway/g2_c_burst", "100 req/s per API key, burst up to 200rps (token bucket).", true],
    ["db-migration/g4_cc_backfill", "Backfill in 5000er-Batches, gedrosselt.", true],
  ] as const)("%s: %s → %s", (ref, text, expected) => {
    const [label, id] = ref.split("/");
    const gt = SETS.find(([l]) => l === label)![1];
    const it = gt.mustSurvive.find((i) => i.id === id)!;
    expect(matchesKeys(text, it.keys!)).toBe(expected);
  });

  it("reads a decimal comma as a point but leaves thousands separators alone", () => {
    expect(normalizeForKeys("p95 1,6 s")).toBe("p95 1.6 s");
    expect(normalizeForKeys("12.000 Events")).toBe("12.000 events");
    expect(normalizeForKeys("12,000 events")).toBe("12,000 events");
    expect(matchesKeys("p95 aktuell 1,6 s", [["1.6 s"]])).toBe(true);
  });
});
