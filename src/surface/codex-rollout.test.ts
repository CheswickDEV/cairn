import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRolloutUsage,
  renderCodexStatusLine,
  findActiveRollout,
  codexSessionsDir,
  readCodexStatusLine,
  listRollouts,
  NO_CONTEXT_LINE,
} from "./codex-rollout.js";

// --- Fixture builders (shape mirrors the real Codex rollout) ----------------------------------
// Window occupancy = last_token_usage.total_tokens (input + output); cached_input_tokens is a
// subset of input_tokens. `output` defaults to 0 so total_tokens == input.
const tokenCount = (input: number, window: number, output = 0) =>
  JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: Math.floor(input / 2),
          output_tokens: output,
          total_tokens: input + output,
        },
        model_context_window: window,
        total_token_usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
      },
    },
  });
const turnContext = (model: string) => JSON.stringify({ type: "turn_context", payload: { model } });
const taskStarted = (window: number) =>
  JSON.stringify({ type: "event_msg", payload: { type: "task_started", model_context_window: window } });
const sessionMeta = (cwd: string, id?: string) =>
  JSON.stringify({ type: "session_meta", payload: { cwd, ...(id ? { id } : {}) } });

describe("parseRolloutUsage — pure", () => {
  it("takes the LAST token_count; occupancy = total_tokens (input + output), last turn_context model", () => {
    const lines = [
      sessionMeta("/work/proj"),
      turnContext("gpt-5.4"),
      taskStarted(128_000),
      tokenCount(5_000, 258_400, 100),
      turnContext("gpt-5.5"),
      tokenCount(20_000, 258_400, 602), // input 20000 + output 602 = 20602
    ];
    const u = parseRolloutUsage(lines);
    expect(u).toEqual({ modelId: "gpt-5.5", window: 258_400, usedTokens: 20_602 });
    expect(u.usedTokens).not.toBe(20_000); // not input_tokens alone - the output is counted (ADR-0008)
  });

  it("does not add cached_input_tokens (subset of input_tokens) — real-rollout numbers", () => {
    const line = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 16_717,
            cached_input_tokens: 12_160,
            output_tokens: 22,
            reasoning_output_tokens: 15,
            total_tokens: 16_739,
          },
          model_context_window: 258_400,
        },
      },
    });
    expect(parseRolloutUsage([line]).usedTokens).toBe(16_739); // = total_tokens, cached NOT added
  });

  it("falls back to input + output when last_token_usage.total_tokens is absent", () => {
    const line = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 20_000, output_tokens: 602 }, model_context_window: 258_400 },
      },
    });
    expect(parseRolloutUsage([line])).toEqual({ modelId: undefined, window: 258_400, usedTokens: 20_602 });
  });

  it("ignores corrupt JSON lines and keeps scanning", () => {
    const lines = [
      "{ this is not json",
      tokenCount(20_602, 258_400),
      "",
      "garbage",
      turnContext("gpt-5.5"),
    ];
    expect(parseRolloutUsage(lines)).toEqual({ modelId: "gpt-5.5", window: 258_400, usedTokens: 20_602 });
  });

  it("falls back to task_started window when no token_count, used = 0", () => {
    const lines = [sessionMeta("/work/proj"), turnContext("gpt-5.5"), taskStarted(128_000)];
    expect(parseRolloutUsage(lines)).toEqual({ modelId: "gpt-5.5", window: 128_000, usedTokens: 0 });
  });

  it("returns used = 0 and undefined model/window when nothing usable is present", () => {
    const lines = [sessionMeta("/work/proj"), "broken"];
    expect(parseRolloutUsage(lines)).toEqual({ modelId: undefined, window: undefined, usedTokens: 0 });
  });
});

describe("renderCodexStatusLine — render mapping (surface-relative, ADR-0003)", () => {
  it("renders the exact green line from the acceptance example", () => {
    expect(renderCodexStatusLine({ modelId: "gpt-5.5", window: 258_400, usedTokens: 20_602 })).toBe(
      "🟢 8% ctx · gpt-5.5",
    );
  });

  it("turns yellow at ≥ 40 % of the rollout window", () => {
    // 0.5 · 258400 = 129200 → yellow
    expect(renderCodexStatusLine({ modelId: "gpt-5.5", window: 258_400, usedTokens: 129_200 })).toBe(
      "🟡 50% ctx · gpt-5.5 · ⚠ consider handoff",
    );
  });

  it("turns red at ≥ 70 % of the rollout window", () => {
    // 0.8 · 258400 = 206720 → red
    expect(renderCodexStatusLine({ modelId: "gpt-5.5", window: 258_400, usedTokens: 206_720 })).toBe(
      "🔴 80% ctx · gpt-5.5 · handoff now",
    );
  });

  it("renders the German zone hint when lang = 'de'", () => {
    expect(renderCodexStatusLine({ modelId: "gpt-5.5", window: 258_400, usedTokens: 129_200 }, "de")).toBe(
      "🟡 50% ctx · gpt-5.5 · ⚠ handoff erwägen",
    );
    expect(renderCodexStatusLine({ modelId: "gpt-5.5", window: 258_400, usedTokens: 206_720 }, "de")).toBe(
      "🔴 80% ctx · gpt-5.5 · handoff jetzt",
    );
  });

  it("computes against the ACTIVE rollout window, not the model max", () => {
    // Same used tokens, smaller rollout window → higher %/hotter zone.
    const wide = renderCodexStatusLine({ modelId: "gpt-5.5", window: 1_000_000, usedTokens: 100_000 });
    const narrow = renderCodexStatusLine({ modelId: "gpt-5.5", window: 200_000, usedTokens: 100_000 });
    expect(wide).toBe("🟢 10% ctx · gpt-5.5"); // 10 % of a 1M window → green
    expect(narrow).toBe("🟡 50% ctx · gpt-5.5 · ⚠ consider handoff"); // same tokens, 50 % of 200k → yellow
  });
});

describe("codexSessionsDir — env overrides", () => {
  it("prefers CAIRN_CODEX_SESSIONS, then CODEX_HOME/sessions", () => {
    expect(codexSessionsDir({ CAIRN_CODEX_SESSIONS: "/x/sess" })).toBe("/x/sess");
    expect(codexSessionsDir({ CODEX_HOME: "/y/.codex" })).toBe(join("/y/.codex", "sessions"));
  });
  it("falls back to ~/.codex/sessions", () => {
    expect(codexSessionsDir({})).toMatch(/[/\\]\.codex[/\\]sessions$/);
  });
});

describe("findActiveRollout / readCodexStatusLine — IO", () => {
  it("returns null and the fallback line when the sessions dir is absent", () => {
    const missing = join(tmpdir(), "cairn-codex-does-not-exist-xyz");
    expect(findActiveRollout(missing)).toBeNull();
    expect(readCodexStatusLine({ sessionsDir: missing })).toBe(NO_CONTEXT_LINE);
  });

  it("picks the newest rollout by mtime, and renders its zone", () => {
    const root = mkdtempSync(join(tmpdir(), "cairn-codex-"));
    try {
      const dir = join(root, "2026", "06", "23");
      mkdirSync(dir, { recursive: true });
      const older = join(dir, "rollout-old.jsonl");
      const newer = join(dir, "rollout-new.jsonl");
      writeFileSync(older, [sessionMeta("/a"), turnContext("gpt-5.5"), tokenCount(200_000, 258_400)].join("\n"));
      writeFileSync(newer, [sessionMeta("/b"), turnContext("gpt-5.5"), tokenCount(20_602, 258_400)].join("\n"));
      // Force mtimes: older < newer.
      utimesSync(older, new Date(1_000_000), new Date(1_000_000));
      utimesSync(newer, new Date(2_000_000), new Date(2_000_000));

      expect(findActiveRollout(dir)).toBe(newer);
      expect(readCodexStatusLine({ sessionsDir: dir })).toBe("🟢 8% ctx · gpt-5.5");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers a cwd match over a newer non-matching rollout", () => {
    const root = mkdtempSync(join(tmpdir(), "cairn-codex-"));
    try {
      const dir = join(root, "2026", "06", "23");
      mkdirSync(dir, { recursive: true });
      const wanted = join(dir, "rollout-wanted.jsonl");
      const newer = join(dir, "rollout-newer.jsonl");
      writeFileSync(wanted, [sessionMeta("/want"), tokenCount(20_602, 258_400)].join("\n"));
      writeFileSync(newer, [sessionMeta("/other"), tokenCount(20_602, 258_400)].join("\n"));
      utimesSync(wanted, new Date(1_000_000), new Date(1_000_000));
      utimesSync(newer, new Date(2_000_000), new Date(2_000_000));

      expect(findActiveRollout(dir, { cwd: "/want" })).toBe(wanted);
      expect(findActiveRollout(dir)).toBe(newer); // no cwd → newest
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins a session deterministically via sessionMatch (UUID/path substring), overriding mtime+cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "cairn-codex-"));
    try {
      const dir = join(root, "2026", "06", "23");
      mkdirSync(dir, { recursive: true });
      const uuid = "019eef84-9ebd-7452-a60b-2240594a4acc";
      const pinned = join(dir, `rollout-2026-06-23T10-00-00-${uuid}.jsonl`);
      const newer = join(dir, "rollout-2026-06-23T11-00-00-other.jsonl");
      writeFileSync(pinned, [sessionMeta("/same", uuid), turnContext("gpt-5.5"), tokenCount(20_602, 258_400)].join("\n"));
      writeFileSync(newer, [sessionMeta("/same"), turnContext("gpt-5.5"), tokenCount(206_720, 258_400)].join("\n"));
      utimesSync(pinned, new Date(1_000_000), new Date(1_000_000));
      utimesSync(newer, new Date(2_000_000), new Date(2_000_000)); // newer + same cwd

      // Pin wins over the newer same-cwd rollout.
      expect(findActiveRollout(dir, { cwd: "/same", sessionMatch: uuid })).toBe(pinned);
      expect(readCodexStatusLine({ sessionsDir: dir, sessionMatch: uuid })).toBe("🟢 8% ctx · gpt-5.5");
      // Env var path is honored too.
      expect(readCodexStatusLine({ sessionsDir: dir, env: { CAIRN_CODEX_SESSION: uuid } })).toBe(
        "🟢 8% ctx · gpt-5.5",
      );
      // A pin that matches nothing → fallback, never a wrong session.
      expect(findActiveRollout(dir, { sessionMatch: "no-such-session" })).toBeNull();
      expect(readCodexStatusLine({ sessionsDir: dir, sessionMatch: "no-such-session" })).toBe(NO_CONTEXT_LINE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("listRollouts summarizes recent sessions (UUID + cwd + zone), newest first", () => {
    const root = mkdtempSync(join(tmpdir(), "cairn-codex-"));
    try {
      const dir = join(root, "2026", "06", "23");
      mkdirSync(dir, { recursive: true });
      const a = join(dir, "rollout-a.jsonl");
      const b = join(dir, "rollout-b.jsonl");
      writeFileSync(a, [sessionMeta("/proj-a", "uuid-aaa"), turnContext("gpt-5.5"), tokenCount(20_602, 258_400)].join("\n"));
      writeFileSync(b, [sessionMeta("/proj-b", "uuid-bbb"), turnContext("gpt-5.5"), tokenCount(206_720, 258_400)].join("\n"));
      utimesSync(a, new Date(1_000_000), new Date(1_000_000));
      utimesSync(b, new Date(2_000_000), new Date(2_000_000));

      const rows = listRollouts(dir);
      expect(rows).toEqual([
        { id: "uuid-bbb", cwd: "/proj-b", statusLine: "🔴 80% ctx · gpt-5.5 · handoff now" },
        { id: "uuid-aaa", cwd: "/proj-a", statusLine: "🟢 8% ctx · gpt-5.5" },
      ]);
      expect(listRollouts(join(root, "missing"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
