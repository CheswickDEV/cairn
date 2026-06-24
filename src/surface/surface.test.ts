import { describe, it, expect, vi } from "vitest";
import { computeStatus, renderStatusline } from "./statusline.js";
import { buildSessionStartContext } from "./session-start.js";
import { buildPreCompactResult, isAllowedTranscriptPath } from "./pre-compact.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { HANDOFF_DECISION_KEY } from "../core/prompts.js";

function fakeClock(): () => string {
  let n = 0;
  return () => `2026-06-21T00:00:${String(n++).padStart(2, "0")}.000Z`;
}
const store = () => new SqliteStore({ path: ":memory:", now: fakeClock() });

describe("statusline (ADR-0003, surface-relative)", () => {
  it("computes the zone from input_tokens against the host window (surface cap = total_tokens)", () => {
    // Opus @200k surface → green ≤80k. 90k input → yellow.
    const s = computeStatus({
      model: { id: "claude-opus-4-8" },
      context_window: { total_tokens: 200_000, input_tokens: 90_000 },
    });
    expect(s.window).toBe(200_000);
    expect(s.zone).toBe("yellow");
    expect(s.usedTokens).toBe(90_000);
  });

  it("falls back to used_percentage when token counts are absent", () => {
    const s = computeStatus({
      model: { id: "claude-opus-4-8" },
      context_window: { total_tokens: 1_000_000, used_percentage: 80 },
    });
    expect(s.usedTokens).toBe(800_000); // 80% of 1M
    expect(s.zone).toBe("red"); // > 700k
  });

  it("renders a one-line string with zone dot, percent and model", () => {
    const line = renderStatusline({
      model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
      context_window: { total_tokens: 1_000_000, input_tokens: 100_000 },
    });
    expect(line).toContain("🟢");
    expect(line).toContain("10% ctx");
    expect(line).toContain("Opus 4.8");
  });

  it("unknown model → generic fallback profile, no crash", () => {
    const s = computeStatus({ model: { id: "???" }, context_window: { total_tokens: 128_000, input_tokens: 0 } });
    expect(s.modelId).toBe("generic:unknown");
    expect(s.zone).toBe("green");
  });

  it("resolves Claude Code's `claude-opus-4-8[1m]` to the real Opus profile (regression)", () => {
    // The [1m] suffix used to miss the profile → generic fallback (128k window, green ≤50%),
    // rendering e.g. "🟢 46%" at ~59k tokens. Must now use the 1M window → ~6%.
    const s = computeStatus({
      model: { id: "claude-opus-4-8[1m]", display_name: "Opus 4.8 (1M context)" },
      context_window: { total_tokens: 1_000_000, input_tokens: 58_880 },
    });
    expect(s.modelId).toBe("claude-opus-4-8");
    expect(s.window).toBe(1_000_000);
    expect(s.zone).toBe("green");
    expect(Math.round(s.usedPct * 100)).toBe(6);
  });
});

describe("session-start re-inject", () => {
  it("formats accepted+open decisions (excludes superseded) as additionalContext", () => {
    const s = store();
    s.appendDecision({ decisionId: "d0", who: "u", decision: "old", rationale: "r" });
    s.appendDecision({ decisionId: "d1", who: "u", decision: "SQLite statt Postgres", rationale: "r", supersedes: "d0" });
    const ctx = buildSessionStartContext(s);
    expect(ctx).toContain("SQLite statt Postgres");
    expect(ctx).not.toContain("old");
    expect(ctx).toContain("1 open/active"); // English is the default
    expect(buildSessionStartContext(s, "de")).toContain("1 offen/aktiv"); // German is selectable
  });

  it("returns empty string when the ledger is empty (no injection)", () => {
    expect(buildSessionStartContext(store())).toBe("");
  });
});

describe("pre-compact safety net", () => {
  it("records a compaction event and returns a handoff nudge", () => {
    const s = store();
    const r = buildPreCompactResult(s, { trigger: "auto", sessionId: "sess1" });
    expect(r.systemMessage).toContain("handoff");
    expect(s.getDecision(r.decisionId)!.decision).toContain("Context compaction (auto)");
    expect(r.storedTail).toBe(false);
  });

  it("persists a transcript tail byte-exact as a verbatim fallback when provided", () => {
    const s = store();
    const tail = "```\nconst id=42; // surfaceCap=200000\n```";
    const r = buildPreCompactResult(s, { trigger: "manual", transcriptTail: tail });
    expect(r.storedTail).toBe(true);
    const ev = s.getEvidence(r.decisionId);
    expect(ev[0].verbatim).toBe(tail);
  });

  it("isAllowedTranscriptPath blocks traversal/absolute paths outside the Claude root (finding 6)", () => {
    const root = "/home/u/.claude";
    expect(isAllowedTranscriptPath("/home/u/.claude/projects/x/s.jsonl", root)).toBe(true);
    expect(isAllowedTranscriptPath("/home/u/.claude", root)).toBe(true);
    expect(isAllowedTranscriptPath("/etc/passwd", root)).toBe(false);
    expect(isAllowedTranscriptPath("/home/u/.claude/../.codex/auth.json", root)).toBe(false);
    expect(isAllowedTranscriptPath("/home/u/.claude-evil/x", root)).toBe(false); // prefix-but-not-subdir
  });
});

/* --------------------- ADR-0007: trigger is advisory, continuation is in-place --------------------- */

describe("ADR-0007 trigger + continuation", () => {
  it("the statusline is advisory-only: a yellow zone triggers NO model call / NO egress (T4)", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const line = renderStatusline({
      model: { id: "claude-opus-4-8" },
      context_window: { total_tokens: 1_000_000, input_tokens: 500_000 }, // 50% → yellow
    });
    expect(line).toContain("🟡");
    expect(fetchSpy).not.toHaveBeenCalled(); // pure display, no budget consumed
    fetchSpy.mockRestore();
  });

  it("SessionStart(compact) carries the latest handoff brief verbatim into the continued context", () => {
    const s = store();
    // Legacy German head value (pre-i18n ledger) - still recognized via LEGACY_HANDOFF_TITLE_DE.
    s.appendDecision({
      decisionId: "h1",
      who: "host",
      decision: "Session-Handoff (7-Bucket-Brief)",
      rationale: "1) DECISIONS\n- OCR-Engine = docTR\n5) VERBATIM: commit a3f9c21",
      status: "accepted",
    });
    const ctx = buildSessionStartContext(s);
    expect(ctx).toContain("Latest handoff brief"); // English default
    expect(ctx).toContain("a3f9c21"); // the full brief is re-injected, not just titles
    expect(buildSessionStartContext(s, "de")).toContain("Letzter Handoff-Brief"); // German selectable
  });

  it("re-injects a brief head stored under the stable key (post-i18n ledger)", () => {
    const s = store();
    s.appendDecision({
      decisionId: "h2",
      who: "host",
      decision: HANDOFF_DECISION_KEY,
      rationale: "1) DECISIONS\n- keep the stable key\n5) VERBATIM: commit b4c1d77",
      status: "accepted",
    });
    const ctx = buildSessionStartContext(s);
    expect(ctx).toContain("Latest handoff brief");
    expect(ctx).toContain("b4c1d77");
  });
});
