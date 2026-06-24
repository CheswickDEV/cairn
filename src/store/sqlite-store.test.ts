import { describe, it, expect } from "vitest";
import { SqliteStore } from "./sqlite-store.js";

/** Deterministic monotonically-increasing clock so `ORDER BY ts` is stable in tests. */
function fakeClock(start = 0): () => string {
  let n = start;
  return () => `2026-06-21T00:00:${String(n++).padStart(2, "0")}.000Z`;
}

function freshStore(): SqliteStore {
  return new SqliteStore({ path: ":memory:", now: fakeClock() });
}

describe("SqliteStore — supersession (append-only, ADR-style)", () => {
  it("a new decision that replaces an old one marks the old superseded and chains both", () => {
    const store = freshStore();
    const d0 = store.appendDecision({
      decisionId: "d0",
      who: "user",
      decision: "Use Postgres",
      rationale: "initial guess",
    });
    const d1 = store.appendDecision({
      decisionId: "d1",
      who: "user",
      decision: "Use SQLite instead",
      rationale: "local-private, zero-build self-install",
      supersedes: "d0",
    });

    const oldRow = store.getDecision("d0")!;
    const newRow = store.getDecision("d1")!;

    expect(oldRow.status).toBe("superseded");
    expect(oldRow.supersededBy).toBe("d1");
    expect(newRow.status).toBe("accepted");
    expect(newRow.supersedes).toBe("d0");
    // Sanity: returned row from appendDecision matches what was persisted.
    expect(d0.decisionId).toBe("d0");
    expect(d1.supersedes).toBe("d0");
    store.close();
  });

  it("never hard-deletes: the superseded row is still retrievable (append-only)", () => {
    const store = freshStore();
    store.appendDecision({ decisionId: "d0", who: "u", decision: "A", rationale: "r" });
    store.appendDecision({ decisionId: "d1", who: "u", decision: "B", rationale: "r", supersedes: "d0" });

    // The old decision survives and is queryable by its superseded status.
    const superseded = store.queryDecisions({ status: "superseded" });
    expect(superseded.map((d) => d.decisionId)).toContain("d0");
    expect(store.getDecision("d0")).not.toBeNull();
    store.close();
  });
});

describe("SqliteStore — currentState re-injection", () => {
  it("reconstructs the current state: accepted + open (proposed), never superseded", () => {
    const store = freshStore();
    store.appendDecision({ decisionId: "d0", who: "u", decision: "old", rationale: "r" });
    store.appendDecision({ decisionId: "d1", who: "u", decision: "new", rationale: "r", supersedes: "d0" });
    store.appendDecision({ decisionId: "d2", who: "u", decision: "open question", rationale: "r", status: "proposed" });

    const ids = store.currentState().map((d) => d.decisionId);
    expect(ids).toContain("d1"); // accepted
    expect(ids).toContain("d2"); // proposed (open)
    expect(ids).not.toContain("d0"); // superseded is excluded
    store.close();
  });
});

describe("SqliteStore — evidence binding + byte-exact verbatim", () => {
  it("binds evidence to its source_ref and preserves verbatim blocks byte-exact", () => {
    const store = freshStore();
    store.appendDecision({ decisionId: "d1", who: "u", decision: "ship it", rationale: "r" });

    const verbatim = "```ts\nconst API_KEY_SCOPE = 'read:logs'; // id=42, π≈3.14159\n```";
    const ev = store.addEvidence({
      decisionId: "d1",
      claim: "exact config block",
      sourceRef: "msg#42",
      type: "tool_out",
      verbatim,
    });

    const read = store.getEvidence("d1");
    expect(read).toHaveLength(1);
    expect(read[0].sourceRef).toBe("msg#42");
    expect(read[0].type).toBe("tool_out");
    // Byte-exact round trip through SQLite.
    expect(read[0].verbatim).toBe(verbatim);
    expect(read[0].verbatim!.length).toBe(verbatim.length);
    expect(ev.evidenceId).toBe(read[0].evidenceId);
    store.close();
  });

  it("supports evidence types msg|file|url|tool_out and null verbatim", () => {
    const store = freshStore();
    store.appendDecision({ decisionId: "d1", who: "u", decision: "x", rationale: "r" });
    for (const type of ["msg", "file", "url", "tool_out"] as const) {
      store.addEvidence({ decisionId: "d1", claim: `c-${type}`, sourceRef: `ref-${type}`, type });
    }
    const ev = store.getEvidence("d1");
    expect(ev.map((e) => e.type).sort()).toEqual(["file", "msg", "tool_out", "url"]);
    expect(ev.every((e) => e.verbatim === null)).toBe(true);
    store.close();
  });
});

describe("SqliteStore — query filters", () => {
  it("filters by status and time range", () => {
    const store = new SqliteStore({ path: ":memory:", now: fakeClock() });
    store.appendDecision({ decisionId: "a", who: "u", decision: "1", rationale: "r" }); // ts ...00
    store.appendDecision({ decisionId: "b", who: "u", decision: "2", rationale: "r" }); // ts ...01
    store.appendDecision({ decisionId: "c", who: "u", decision: "3", rationale: "r", status: "proposed" }); // ts ...02

    expect(store.queryDecisions({ status: "accepted" }).map((d) => d.decisionId)).toEqual(["a", "b"]);
    expect(store.queryDecisions({ status: "proposed" }).map((d) => d.decisionId)).toEqual(["c"]);
    const ranged = store.queryDecisions({
      since: "2026-06-21T00:00:01.000Z",
      until: "2026-06-21T00:00:02.000Z",
    });
    expect(ranged.map((d) => d.decisionId)).toEqual(["b", "c"]);
    store.close();
  });
});
