/**
 * Cairn — golden-set probe #5 (ADR-0005). Domain: Kubernetes-Deployment / Rollout (config- und
 * zahlenlastig). Gleiche Fallen-Struktur (primacy / supersession / verbatim / buried / recency).
 * Konzis, kein Padding.
 */

import type { GroundTruth } from "./ground-truth.js";

const VALUES_YAML = `replicas: 6
image:
  digest: sha256:9f2a7c1e4b0d
resources:
  requests: { cpu: "1", memory: "2Gi" }
  limits:   { cpu: "2", memory: "4Gi" }
strategy:
  rollingUpdate: { maxUnavailable: 0, maxSurge: 1 }`;

const PDB_YAML = `apiVersion: policy/v1
kind: PodDisruptionBudget
spec:
  minAvailable: 5`;

export const GOLDEN5_GROUND_TRUTH: GroundTruth = {
  weights: { recall: 0.4, hallucination: 0.3, supersession: 0.15, verbatim: 0.15 },
  mustSurvive: [
    { id: "g5_c_probes", kind: "constraint", primacy: true, sourceRef: "K01", text: "Jeder Pod MUSS Liveness- + Readiness-Probe und Resource-Limits haben, sonst kein Deploy." },
    { id: "g5_c_zero", kind: "constraint", primacy: true, sourceRef: "K01", text: "Rollout muss zero-downtime sein: maxUnavailable=0." },
    { id: "g5_d_kind0", kind: "decision", status: "superseded", supersededBy: "g5_d_kind1", sourceRef: "K02", text: "Deployment (stateless) für den Service (initialer Ansatz)." },
    { id: "g5_d_kind1", kind: "decision", status: "accepted", supersedes: "g5_d_kind0", sourceRef: "K03", text: "StatefulSet (stabile Netz-ID + PVC), da der Service Zustand hält." },
    { id: "g5_d_tag0", kind: "decision", status: "discarded", sourceRef: "K04", text: ":latest-Tag vorgeschlagen, verworfen (nicht reproduzierbar)." },
    { id: "g5_d_tag1", kind: "decision", status: "accepted", sourceRef: "K04", text: "Image per immutable Digest pinnen." },
    { id: "g5_d_deploy", kind: "decision", status: "discarded", sourceRef: "K05", text: "Manuelles kubectl apply verworfen; GitOps via ArgoCD gewählt." },
    { id: "g5_v_values", kind: "verbatim", exact: true, sourceRef: "K06", text: VALUES_YAML },
    { id: "g5_v_pdb", kind: "verbatim", exact: true, sourceRef: "K07", text: PDB_YAML },
    { id: "g5_v_digest", kind: "verbatim", exact: true, sourceRef: "K06", text: "sha256:9f2a7c1e4b0d" },
    { id: "g5_v_probe", kind: "verbatim", exact: true, sourceRef: "K08", text: "/healthz" },
    { id: "g5_cc_delay", kind: "critical_context", buried: true, sourceRef: "K08", text: "readinessProbe.initialDelaySeconds MUSS ≥ JVM-Warmup (45 s); zu früh → Rollout killte gesunde Pods (Incident). Nicht senken." },
    { id: "g5_n_replicas", kind: "number", sourceRef: "K06", text: "replicas = 6; CPU-Limit 2; Memory-Limit 4Gi." },
    { id: "g5_n_pdb", kind: "number", sourceRef: "K07", text: "PodDisruptionBudget minAvailable = 5." },
    { id: "g5_o_hpa", kind: "open_decision", sourceRef: "K09", text: "OFFEN: ob HPA auf Custom-Metrics (Queue-Depth) statt CPU umgestellt wird — noch nicht entschieden." },
    { id: "g5_r_next", kind: "recency", sourceRef: "K10", text: "Nächster Schritt: PodDisruptionBudget + Node-Drain im Failover-Test prüfen." },
  ],
  mustNotAppear: [
    ":latest-Tag als genutzte Image-Referenz.",
    "Deployment als finale Wahl für den zustandsbehafteten Service.",
    "Manuelles kubectl apply als Deploy-Prozess.",
    "maxUnavailable größer als 0.",
    "Eine konkrete Kubernetes-Versionsnummer.",
  ],
};

export const GOLDEN5_PROBE = [
  "# K8S — Deployment / Rollout",
  "",
  "[K01] Nora: Zwei harte Vorgaben: (1) Jeder Pod MUSS **Liveness+Readiness-Probe + Resource-Limits** haben, sonst kein Deploy. " +
    "(2) Rollout **zero-downtime: maxUnavailable=0**. Alles dagegen prüfen.",
  "[K02] Tim: Ich deploye den Service als **Deployment**.",
  "[K03] Nora: Der Service hält Zustand — Deployment passt nicht. Korrektur: **StatefulSet** (stabile Netz-ID + PVC). Deployment ist raus.",
  "[K04] Tim: Image als **:latest**? Nora: Nicht reproduzierbar — **verworfen**. **Immutable Digest pinnen**.",
  "[K05] Tim: Deploy manuell per kubectl? Nora: **Verworfen** — **GitOps via ArgoCD**.",
  "[K06] Tim: values.yaml:",
  "```yaml",
  VALUES_YAML,
  "```",
  "[K07] Nora: PodDisruptionBudget:",
  "```yaml",
  PDB_YAML,
  "```",
  "[K08] Tim: Health-Endpoint ist `/healthz` (WICHTIG: readinessProbe.initialDelaySeconds **≥ 45 s JVM-Warmup** — zu früh killte uns gesunde Pods).",
  "[K09] Nora: OFFEN: ob wir HPA auf Custom-Metrics (Queue-Depth) statt CPU umstellen — noch offen.",
  "[K10] Nora: **Nächster Schritt:** PodDisruptionBudget + Node-Drain im Failover-Test prüfen.",
].join("\n");

export const GOLDEN5_EXACT_SPANS: string[] = GOLDEN5_GROUND_TRUTH.mustSurvive
  .filter((i) => i.exact)
  .map((i) => i.text);
