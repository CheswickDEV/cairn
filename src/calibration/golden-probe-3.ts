/**
 * Cairn — golden-set probe #3 (ADR-0005). Domain: OAuth2 / Token-Service (security-lastig →
 * betont das verbatim-Gewicht). Gleiche Fallen-Struktur wie die anderen Proben
 * (primacy / supersession / verbatim / buried / recency). Konzis, kein Padding.
 */

import type { GroundTruth } from "./ground-truth.js";

const TOKEN_CFG = `oauth:
  access_token_ttl: 900     # 15 min, hart
  refresh_token_ttl_days: 30
  refresh_rotation: true     # Reuse-Detection
  signing_alg: RS256
  key_rotation_days: 90`;

const PKCE_FN = `def make_challenge(verifier):
    # PKCE: S256, niemals "plain"
    digest = sha256(verifier.encode("ascii")).digest()
    return b64url_nopad(digest)`;

export const GOLDEN3_GROUND_TRUTH: GroundTruth = {
  weights: { recall: 0.4, hallucination: 0.3, supersession: 0.15, verbatim: 0.15 },
  mustSurvive: [
    { id: "g3_c_ttl", kind: "constraint", primacy: true, sourceRef: "A01", text: "Access-Token-TTL maximal 15 Minuten; Refresh-Token-Rotation ist Pflicht.", keys: [["15 min*","15min*","15-min*"],["refresh*"],["*rotation*","rotier*","rotat*"]] },
    { id: "g3_c_store", kind: "constraint", primacy: true, sourceRef: "A01", text: "Tokens niemals im localStorage (XSS); nur httpOnly+Secure-Cookie.", keys: [["localstorage","local storage"],["httponly","http-only","http only"]] },
    { id: "g3_d_grant0", kind: "decision", status: "superseded", supersededBy: "g3_d_grant1", sourceRef: "A02", text: "Implicit Grant als Flow (initialer Ansatz).", keys: [["implicit*","implizit*"]] },
    { id: "g3_d_grant1", kind: "decision", status: "accepted", supersedes: "g3_d_grant0", sourceRef: "A03", text: "Authorization Code Flow mit PKCE (S256).", keys: [["pkce"],["authorization code","authorization-code","auth code","code flow","code-flow"]] },
    { id: "g3_d_alg0", kind: "decision", status: "discarded", sourceRef: "A04", text: "HS256 (symmetrisch) vorgeschlagen, verworfen.", keys: [["hs256"]] },
    { id: "g3_d_alg1", kind: "decision", status: "accepted", sourceRef: "A04", text: "RS256 (asymmetrisch) mit Key-Rotation gewählt.", keys: [["rs256"]] },
    { id: "g3_v_cfg", kind: "verbatim", exact: true, sourceRef: "A05", text: TOKEN_CFG },
    { id: "g3_v_fn", kind: "verbatim", exact: true, sourceRef: "A06", text: PKCE_FN },
    { id: "g3_v_endpoint", kind: "verbatim", exact: true, sourceRef: "A07", text: "/oauth/token" },
    { id: "g3_v_err", kind: "verbatim", exact: true, sourceRef: "A07", text: "invalid_grant" },
    { id: "g3_cc_skew", kind: "critical_context", buried: true, sourceRef: "A06", text: "JWT-exp-Prüfung MUSS ±30 s Clock-Skew erlauben; strikte Validierung killte in Prod gültige Sessions. Nicht verschärfen.", keys: [["30 s","30s","30-s*","30 sek*","30-sek*","30sek*","30 sec*","30-sec*","30sec*","30 second*","30-second*","±30","half a minute","half-minute","halbe minute","halben minute"],["*skew*","clock*","uhr*","toleran*","leeway","abweich*"]] },
    { id: "g3_n_refresh", kind: "number", sourceRef: "A05", text: "Refresh-Token-TTL = 30 Tage.", keys: [["30 tag*","30-tag*","30-tägig*","30 days","30 day","30-day*","30d","ttl_days: 30","lifetime: one month","lifetime of one month","ttl: one month","ttl one month","ttl of one month","ttl 1 month","ttl: 1 month","ttl = 1 month","ttl 1 monat","ttl: 1 monat","ttl = 1 monat","one-month ttl","1-month ttl","one-month lifetime","valid for one month","valid for a month","valid for 1 month","expire after one month","expire after a month","expire after 1 month","expires after one month","expires after a month","expires after 1 month","nach einem monat ablauf*","einen monat gültig","gilt einen monat","gilt 1 monat","gültigkeit: einen monat","gültigkeit: 1 monat","laufzeit: ein monat","laufzeit: 1 monat","laufzeit 1 monat","laufzeit von einem monat"],["refresh*"]] },
    { id: "g3_n_rot", kind: "number", sourceRef: "A05", text: "Signing-Key-Rotation alle 90 Tage.", keys: [["90 tag*","90-tag*","90-tägig*","90 days","90 day","90-day*","90d","rotation_days: 90","rotate quarterly","rotated quarterly","rotates quarterly","rotation: quarterly","rotation quarterly","quarterly rotation","quarterly key rotation","rotate every quarter","rotated every quarter","rotation every quarter","quartalsweise","quartalsrhythmus","pro quartal rotier*","jedes quartal rotier*","rotiert jedes quartal","vierteljährlich rotier*","vierteljährliche rotation","every three months","every 3 months","alle drei monate","alle 3 monate"],["*rotation*","rotier*","rotat*"]] },
    { id: "g3_o_introspect", kind: "open_decision", sourceRef: "A08", text: "OFFEN: ob ein zentraler Token-Introspection-Endpoint eingeführt wird — noch nicht entschieden.", keys: [["*introspect*"]] },
    { id: "g3_r_next", kind: "recency", sourceRef: "A09", text: "Nächster Schritt: Refresh-Token-Reuse-Detection (Replay) implementieren und Family-Revocation testen.", keys: [["*reuse*","wiederverwend*","replay*"],["*family*","*familie*","*revocation*","revok*","widerruf*"]] },
  ],
  mustNotAppear: [
    "Implicit Grant als gewählter finaler Flow.",
    "HS256 als gewähltes Signing-Verfahren.",
    "Tokens im localStorage ablegen.",
    "Access-Token-TTL über 15 Minuten.",
    "Eine konkrete OAuth-Library-Versionsnummer.",
  ],
};

export const GOLDEN3_PROBE = [
  "# AUTH — OAuth2 / Token-Service",
  "",
  "[A01] Sara: Zwei harte Security-Vorgaben: (1) **Access-Token-TTL max. 15 min**, Refresh-Token-Rotation Pflicht. " +
    "(2) **Keine Tokens im localStorage** (XSS) — nur **httpOnly+Secure-Cookie**. Alles dagegen abklopfen.",
  "[A02] Ben: Für den Flow nehme ich erstmal **Implicit Grant**.",
  "[A03] Sara: Implicit ist veraltet (Token im Fragment). Korrektur: **Authorization Code + PKCE (S256)**. Implicit ist raus.",
  "[A04] Ben: Signatur — **HS256**? Sara: Nein, **RS256** (asymmetrisch, Key-Rotation). HS256 verworfen.",
  "[A05] Ben: Config:",
  "```yaml",
  TOKEN_CFG,
  "```",
  "[A06] Sara: PKCE-Challenge (WICHTIG: exp-Prüfung MUSS **±30 s Clock-Skew** dulden — strikte Validierung killte in Prod gültige Sessions):",
  "```python",
  PKCE_FN,
  "```",
  "[A07] Ben: Token-Endpoint ist `/oauth/token`; Fehlerfall liefert `invalid_grant`.",
  "[A08] Sara: OFFEN: ob wir einen zentralen Token-Introspection-Endpoint einführen — noch offen.",
  "[A09] Sara: **Nächster Schritt:** Refresh-Token-Reuse-Detection (Replay) implementieren und Family-Revocation testen.",
].join("\n");

export const GOLDEN3_EXACT_SPANS: string[] = GOLDEN3_GROUND_TRUTH.mustSurvive
  .filter((i) => i.exact)
  .map((i) => i.text);
