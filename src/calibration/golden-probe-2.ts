/**
 * Cairn — second golden-set probe (ADR-0005). A distinct domain (API-Gateway rate-limiting +
 * caching) so the golden set averages over more than one scenario → less single-probe noise. Same
 * trap structure as the others (primacy/supersession/verbatim/buried/recency). Concise (no padding).
 */

import type { GroundTruth } from "./ground-truth.js";

const RL_CONFIG = `rate_limit:
  per_key: 100        # req/s
  burst: 200          # token-bucket capacity
  algorithm: token_bucket
cache:
  backend: redis
  max_stale_seconds: 60`;

const BUCKET_FN = `def allow(bucket, now_monotonic):
    # refill uses a monotonic clock (NTP jumps caused a burst bug)
    bucket.tokens = min(bucket.capacity, bucket.tokens + (now_monotonic - bucket.ts) * bucket.rate)
    bucket.ts = now_monotonic
    if bucket.tokens < 1:
        return False
    bucket.tokens -= 1
    return True`;

export const GOLDEN2_GROUND_TRUTH: GroundTruth = {
  weights: { recall: 0.4, hallucination: 0.3, supersession: 0.15, verbatim: 0.15 },
  mustSurvive: [
    { id: "g2_c_burst", kind: "constraint", primacy: true, sourceRef: "G01", text: "Rate-Limit: 100 req/s pro API-Key, Burst bis 200 (Token-Bucket)." },
    { id: "g2_c_stale", kind: "constraint", primacy: true, sourceRef: "G01", text: "Cache darf maximal 60 s stale sein (Compliance)." },
    { id: "g2_d_store0", kind: "decision", status: "superseded", supersededBy: "g2_d_store1", sourceRef: "G02", text: "In-Memory-Counter pro Instanz fürs Rate-Limiting (initialer Ansatz)." },
    { id: "g2_d_store1", kind: "decision", status: "accepted", supersedes: "g2_d_store0", sourceRef: "G04", text: "Redis (zentral) für die Rate-Limit-Counter." },
    { id: "g2_d_cache0", kind: "decision", status: "discarded", sourceRef: "G05", text: "Memcached als Cache (vorgeschlagen, verworfen)." },
    { id: "g2_d_cache1", kind: "decision", status: "accepted", sourceRef: "G06", text: "Redis auch als Cache (ein System weniger)." },
    { id: "g2_d_algo", kind: "decision", status: "discarded", sourceRef: "G07", text: "Sliding-Window-Log verworfen (zu speicherintensiv); Token-Bucket gewählt." },
    { id: "g2_v_config", kind: "verbatim", exact: true, sourceRef: "G03", text: RL_CONFIG },
    { id: "g2_v_fn", kind: "verbatim", exact: true, sourceRef: "G08", text: BUCKET_FN },
    { id: "g2_v_key", kind: "verbatim", exact: true, sourceRef: "G09", text: "X-RateLimit-Remaining" },
    { id: "g2_v_err", kind: "verbatim", exact: true, sourceRef: "G09", text: "429 Too Many Requests — Retry-After: 1" },
    { id: "g2_cc_clock", kind: "critical_context", buried: true, sourceRef: "G08", text: "Token-Refill MUSS eine server-monotonic clock nutzen; NTP-Sprünge führten zu einem Burst-Bug. Nicht ändern." },
    { id: "g2_n_hit", kind: "number", sourceRef: "G10", text: "Cache-Hit-Rate aktuell 87 %." },
    { id: "g2_n_p95", kind: "number", sourceRef: "G10", text: "Gateway-p95 = 12 ms." },
    { id: "g2_o_shard", kind: "open_decision", sourceRef: "G11", text: "OFFEN: ob Redis bei mehr Last gesharded wird — noch nicht entschieden." },
    { id: "g2_r_next", kind: "recency", sourceRef: "G12", text: "Nächster Schritt: Redis-Cluster-Failover testen und die Rate-Limit-Counter-Konsistenz unter Failover messen." },
  ],
  mustNotAppear: [
    "In-Memory-Counter als finale Rate-Limit-Lösung.",
    "Memcached als gewählter/genutzter Cache.",
    "Sliding-Window-Log als gewählter Algorithmus.",
    "Cache-TTL über 60 Sekunden.",
    "Eine konkrete Redis-Versionsnummer.",
  ],
};

export const GOLDEN2_PROBE = [
  "# API-GATEWAY — Rate-Limiting + Caching",
  "",
  "[G01] Lena: Zwei harte Vorgaben für alles: (1) Rate-Limit **100 req/s pro API-Key, Burst bis 200** (Token-Bucket). " +
    "(2) Der Cache darf **maximal 60 s stale** sein (Compliance). Jede Entscheidung dagegen prüfen.",
  "[G02] Tomas: Fürs Rate-Limiting nehme ich erstmal **In-Memory-Counter pro Instanz**.",
  "[G03] Tomas: Config-Entwurf:",
  "```yaml",
  RL_CONFIG,
  "```",
  "[G04] Mara: In-Memory ist pro-Instanz inkonsistent (mehrere Gateways). Korrektur: **Redis (zentral)** für die Counter. In-Memory ist raus.",
  "[G05] Tomas: Cache — Memcached?",
  "[G06] Mara: Wir haben schon Redis. **Redis auch als Cache** — ein System weniger. Memcached verworfen.",
  "[G07] Tomas: Rate-Limit-Algorithmus: Sliding-Window-Log ist zu speicherintensiv — **verworfen**. **Token-Bucket** gewählt.",
  "[G08] Mara: Token-Bucket-Check (WICHTIG: Refill über **server-monotonic clock**, weil NTP-Sprünge einen Burst-Bug verursacht haben):",
  "```python",
  BUCKET_FN,
  "```",
  "[G09] Tomas: Antwort-Header: `X-RateLimit-Remaining`. Bei Überschreitung: `429 Too Many Requests — Retry-After: 1`.",
  "[G10] Tomas: Stand: Cache-Hit-Rate **87 %**, Gateway-p95 **12 ms**.",
  "[G11] Mara: OFFEN: ob wir Redis bei mehr Last sharden — noch nicht entschieden.",
  "[G12] Lena: **Nächster Schritt:** Redis-Cluster-Failover testen und die Rate-Limit-Counter-Konsistenz unter Failover messen.",
].join("\n");

export const GOLDEN2_EXACT_SPANS: string[] = GOLDEN2_GROUND_TRUTH.mustSurvive
  .filter((i) => i.exact)
  .map((i) => i.text);
