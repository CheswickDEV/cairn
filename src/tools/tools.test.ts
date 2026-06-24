import { describe, it, expect, vi } from "vitest";
import { buildContextStatus } from "./context_status.js";
import { buildDecisionLog } from "./decision_log.js";
import { runHandoff } from "./handoff.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { loadConfig, type CairnConfig } from "../core/config.js";
import { EgressNotConfiguredError } from "../core/providers.js";
import { HANDOFF_DECISION_KEY } from "../core/prompts.js";

function fakeClock(): () => string {
  let n = 0;
  return () => `2026-06-21T00:00:${String(n++).padStart(2, "0")}.000Z`;
}

/* ----------------------------- context_status ----------------------------- */

describe("context_status tool", () => {
  it("Opus 4.8 @1M: green ≤400k, yellow ≤700k (zone math via the tool)", () => {
    const r = buildContextStatus({ host: { modelId: "claude-opus-4-8" }, usedTokens: 300_000 });
    expect(r.greenUntil).toBe(400_000);
    expect(r.yellowUntil).toBe(700_000);
    expect(r.zone).toBe("green");
  });

  it("is surface-relative: surfaceCap 200000 → green ≤80k (ADR-0003)", () => {
    const r = buildContextStatus({
      host: { modelId: "claude-opus-4-8" },
      usedTokens: 90_000,
      surfaceCap: 200_000,
    });
    expect(r.window).toBe(200_000);
    expect(r.greenUntil).toBe(80_000);
    expect(r.zone).toBe("yellow"); // 90k > 80k green edge
  });

  it("falls back to the generic profile for an unknown model", () => {
    const r = buildContextStatus({ host: { modelId: "mystery-model" }, usedTokens: 0 });
    expect(r.modelId).toBe("generic:unknown");
  });
});

/* -------------------------------- handoff -------------------------------- */

describe("handoff tool (account mode, ADR-0006)", () => {
  const brief = "Decision: keep SQLite.\n```ts\nconst SCOPE='read:logs'; // id=42\n```";

  function deps(configOverride?: CairnConfig) {
    const store = new SqliteStore({ path: ":memory:", now: fakeClock() });
    const config = configOverride ?? loadConfig({});
    const fetchSpy = vi.fn();
    return { store, config, fetchSpy, deps: { store, config, fetchFn: fetchSpy as unknown as typeof fetch } };
  }

  it("default mode makes NO model call / NO egress and persists the brief + verbatim", async () => {
    const { store, fetchSpy, deps: d } = deps();
    const r = await runHandoff(
      { brief, host: { modelId: "claude-opus-4-8" }, sourceZone: "yellow", requiredVerbatim: ["read:logs"] },
      d,
    );
    expect(r.mode).toBe("account");
    expect(r.egress).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled(); // ← the egress guardrail in practice
    expect(r.verbatimHolds).toBe(1); // the fenced block
    expect(r.missingRequired).toEqual([]); // read:logs survived byte-exact
    // Persisted: the brief is now a decision with byte-exact verbatim evidence.
    const ev = store.getEvidence(r.storedDecisionId);
    expect(ev).toHaveLength(1);
    expect(ev[0].verbatim).toContain("read:logs");
    expect(store.currentState().map((dd) => dd.decisionId)).toContain(r.storedDecisionId);
  });

  it("an Anthropic host is never assigned an OpenAI model (ADR-0004)", async () => {
    const { deps: d } = deps();
    const r = await runHandoff({ brief, host: { modelId: "claude-sonnet-4-6" }, sourceZone: "green" }, d);
    expect(r.selectionKind).toBe("model");
    expect(r.modelId?.startsWith("gpt")).toBe(false);
  });

  it("red zone with only a weak reachable model → verbatim-fallback (ADR-0004)", async () => {
    const { deps: d } = deps();
    const r = await runHandoff(
      {
        brief,
        host: { modelId: "claude-haiku-4-5-20251001" },
        sourceZone: "red",
        fidelityFloor: 0.95, // red +0.10 → 1.05; even calibrated Haiku (0.980) can't clear it → verbatim
      },
      { ...d, reachable: async (p) => p.id === "claude-haiku-4-5-20251001" },
    );
    expect(r.selectionKind).toBe("verbatim-fallback");
  });

  it("reports required verbatim the host failed to preserve byte-exact", async () => {
    const { deps: d } = deps();
    const r = await runHandoff(
      { brief, host: { modelId: "claude-opus-4-8" }, sourceZone: "green", requiredVerbatim: ["id=99"] },
      d,
    );
    expect(r.missingRequired).toEqual(["id=99"]);
  });

  it("optional API mode at an unconfigured endpoint is refused (no egress)", async () => {
    const { fetchSpy, deps: d } = deps(); // default config: api not enabled, no endpoints
    await expect(
      runHandoff({ brief, host: { modelId: "claude-opus-4-8" }, sourceZone: "green", mode: "api" }, d),
    ).rejects.toBeInstanceOf(EgressNotConfiguredError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("persists host-extracted structured decisions with supersession", async () => {
    const { store, deps: d } = deps();
    await runHandoff(
      {
        brief: "handoff",
        host: { modelId: "claude-opus-4-8" },
        sourceZone: "green",
        decisions: [
          { decisionId: "d0", decision: "Postgres", rationale: "initial" },
          { decisionId: "d1", decision: "SQLite instead", rationale: "self-install", supersedes: "d0" },
        ],
      },
      d,
    );
    expect(store.getDecision("d0")!.status).toBe("superseded");
    expect(store.getDecision("d1")!.status).toBe("accepted");
  });

  it("a new handoff supersedes the previous brief head — view=current keeps only the latest", async () => {
    const store = new SqliteStore({ path: ":memory:", now: fakeClock() });
    const config = loadConfig({});
    const host = { modelId: "claude-opus-4-8" };
    const first = await runHandoff({ brief: "Brief A", host, sourceZone: "green" }, { store, config });
    const second = await runHandoff({ brief: "Brief B", host, sourceZone: "green" }, { store, config });

    expect(store.getDecision(first.storedDecisionId)!.status).toBe("superseded");
    expect(store.getDecision(second.storedDecisionId)!.status).toBe("accepted");
    const heads = store
      .currentState()
      .filter((d) => d.decision === HANDOFF_DECISION_KEY)
      .map((d) => d.decisionId);
    expect(heads).toEqual([second.storedDecisionId]); // exactly one live brief, not two
  });
});

/* ------------------------------ decision_log ------------------------------ */

describe("decision_log tool", () => {
  it("view 'current' reconstructs accepted + open, excludes superseded; 'all' keeps history", () => {
    const store = new SqliteStore({ path: ":memory:", now: fakeClock() });
    store.appendDecision({ decisionId: "d0", who: "u", decision: "old", rationale: "r" });
    store.appendDecision({ decisionId: "d1", who: "u", decision: "new", rationale: "r", supersedes: "d0" });

    const current = buildDecisionLog({ view: "current" }, store);
    expect(current.decisions.map((d) => d.decisionId)).toEqual(["d1"]);

    const all = buildDecisionLog({ view: "all" }, store);
    expect(all.decisions.map((d) => d.decisionId).sort()).toEqual(["d0", "d1"]);
  });

  it("attaches evidence in view=all; view=current stays lean even with withEvidence", () => {
    const store = new SqliteStore({ path: ":memory:", now: fakeClock() });
    const d = store.appendDecision({ decisionId: "d1", who: "u", decision: "x", rationale: "r" });
    store.addEvidence({ decisionId: d.decisionId, claim: "c", sourceRef: "msg#1", type: "msg" });

    const all = buildDecisionLog({ view: "all", withEvidence: true }, store);
    expect(all.decisions[0].evidence).toHaveLength(1);

    // current is the session-start reconstruction → evidence is intentionally not bulk-attached.
    const current = buildDecisionLog({ view: "current", withEvidence: true }, store);
    expect(current.decisions[0].evidence).toBeUndefined();
  });
});
