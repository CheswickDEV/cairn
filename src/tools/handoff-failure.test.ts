import { describe, it, expect, vi } from "vitest";
import { runHandoff, type HandoffInput } from "./handoff.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { loadConfig, type CairnConfig } from "../core/config.js";
import { productBridge, type ExecFn } from "../core/bridge.js";
import {
  CompactionFailedError,
  EgressNotConfiguredError,
  callAnthropic,
  callGemini,
  callOpenAICompatible,
  type ModelCaller,
} from "../core/providers.js";
import { HANDOFF_DECISION_KEY } from "../core/prompts.js";

/* ADR-0012: a compaction call that failed or returned no text stores nothing - no brief, no decision, no
   evidence - so the previous brief stays current. */

const ep = { baseUrl: "https://api.example.test", apiKeyEnv: "KEY", model: "m" };
const req = { prompt: "p", maxTokens: 10, model: "m" };
const res = (status: number, body: string) => async () => new Response(body, { status });

describe("the API adapters refuse an HTTP error with the provider's message", () => {
  it.each([
    ["anthropic", callAnthropic, 404, { type: "error", error: { type: "not_found_error", message: "model: m" } }, "anthropic API returned HTTP 404: model: m"],
    ["openai", callOpenAICompatible, 401, { error: { message: "Incorrect API key provided", type: "invalid_request_error" } }, "openai API returned HTTP 401: Incorrect API key provided"],
    ["gemini", callGemini, 400, { error: { code: 400, message: "API key not valid", status: "INVALID_ARGUMENT" } }, "gemini API returned HTTP 400: API key not valid"],
  ] as const)("%s", async (provider, call, status, body, message) => {
    const p = call({ ...ep, provider }, req, res(status, JSON.stringify(body)) as never, { KEY: "k" });
    await expect(p).rejects.toThrow(CompactionFailedError);
    await expect(call({ ...ep, provider }, req, res(status, JSON.stringify(body)) as never, { KEY: "k" })).rejects.toThrow(message);
  });

  it("a body that is no JSON (a gateway's error page) still fails, with the status only", async () => {
    await expect(callAnthropic({ ...ep, provider: "anthropic" }, req, res(502, "<html>Bad Gateway</html>") as never, {})).rejects.toThrow(
      /^anthropic API returned HTTP 502$/,
    );
  });
});

describe("a failed or empty compaction stores nothing; the previous brief stays current", () => {
  /** A store holding one earlier brief, a host decision and evidence. */
  const seeded = async () => {
    const store = new SqliteStore({ path: ":memory:" });
    await runHandoff(
      { brief: "1) DECISIONS earlier brief", host: { modelId: "claude-opus-5-5" }, sourceZone: "green", decisions: [{ decision: "keep", rationale: "r" }] },
      { store, config: loadConfig({}) },
    );
    return { store, before: JSON.stringify(store.currentState()) };
  };
  const input = (mode: HandoffInput["mode"], modelId = "claude-opus-5-5"): HandoffInput => ({
    brief: "",
    source: "the raw context",
    host: { modelId },
    sourceZone: "red",
    mode,
    exactSpans: ["SQLITE_BUSY"],
    decisions: [{ decision: "must not be stored", rationale: "r" }],
    evidence: [{ claim: "c", sourceRef: "s", type: "msg" }],
  });

  const expectUnchanged = (store: SqliteStore, before: string) => {
    expect(JSON.stringify(store.currentState())).toBe(before);
    expect(store.currentState().filter((d) => d.decision === HANDOFF_DECISION_KEY).map((d) => d.rationale)).toEqual(["1) DECISIONS earlier brief"]);
  };

  it("API: an HTTP error and a 200 without text", async () => {
    const config: CairnConfig = {
      enabledModes: ["account", "api"],
      endpoints: { main: { provider: "anthropic", baseUrl: "https://api.example.test" } },
      storePath: ":memory:",
    };
    for (const [fetchFn, reason] of [
      [res(529, JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })), /HTTP 529: Overloaded/],
      [res(200, JSON.stringify({ content: [], stop_reason: "end_turn" })), /api compaction returned no text; nothing stored/],
      [res(200, JSON.stringify({ content: [{ type: "text", text: "  \n " }], stop_reason: "end_turn" })), /returned no text/],
    ] as const) {
      const { store, before } = await seeded();
      const run = runHandoff(input("api"), { store, config, fetchFn: fetchFn as never });
      await expect(run).rejects.toThrow(CompactionFailedError);
      await expect(run).rejects.toThrow(reason);
      expectUnchanged(store, before);
    }
  });

  it("bridge: a claude error result and a failed Codex run with a partial answer", async () => {
    const cases: [CairnConfig["bridgeCli"], string, string, RegExp][] = [
      ["claude", "claude-opus-5-5", JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "API Error: 529 overloaded" }), /bridge compaction failed: API Error: 529 overloaded/],
      [
        "codex",
        "gpt-6.1-sol",
        [
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "1) DECISIONS half a br" } }),
          JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected" } }),
        ].join("\n"),
        /bridge compaction failed/,
      ],
      ["codex", "gpt-6.1-sol", JSON.stringify({ type: "turn.completed" }), /bridge compaction returned no text/],
      // A CLI that fails without output: the bridge throws, the handoff reports it as a failed compaction.
      ["claude", "claude-opus-5-5", "", /bridge compaction failed: claude bridge failed \(code 1\): boom; nothing stored/],
    ];
    for (const [cli, modelId, stdout, reason] of cases) {
      const { store, before } = await seeded();
      const exec = vi.fn<ExecFn>(async () => ({ stdout, stderr: stdout ? "" : "boom", code: stdout ? 0 : 1 }));
      const run = runHandoff(input("bridge", modelId), {
        store,
        config: loadConfig({ CAIRN_ENABLE_MODES: "bridge", CAIRN_BRIDGE: cli }),
        bridge: productBridge(cli!, "en", exec),
      });
      await expect(run).rejects.toThrow(CompactionFailedError);
      await expect(run).rejects.toThrow(reason);
      expectUnchanged(store, before);
    }
  });

  it("API: a network failure is a failed compaction; a refusal before the call stays an egress refusal", async () => {
    const config: CairnConfig = {
      enabledModes: ["account", "api"],
      endpoints: { main: { provider: "anthropic", baseUrl: "https://api.example.test" } },
      storePath: ":memory:",
    };
    const { store, before } = await seeded();
    const fetchFn = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(runHandoff(input("api"), { store, config, fetchFn: fetchFn as never })).rejects.toThrow(
      /^api compaction failed: fetch failed; nothing stored/,
    );
    const refused = runHandoff(input("api", "gpt-6.1-sol"), { store, config, fetchFn: fetchFn as never });
    await expect(refused).rejects.toThrow(EgressNotConfiguredError);
    await expect(refused).rejects.not.toThrow(CompactionFailedError);
    expectUnchanged(store, before);
  });

  it("sampling: a client answer without text", async () => {
    const { store, before } = await seeded();
    const sample = vi.fn<ModelCaller>(async () => ({ text: "", truncated: false, finishReason: "endTurn" }));
    const run = runHandoff(input("sampling"), { store, config: loadConfig({ CAIRN_ENABLE_MODES: "sampling" }), sample });
    await expect(run).rejects.toThrow(/sampling compaction returned no text; nothing stored, the previous brief stays current/);
    expectUnchanged(store, before);
  });

  it("a successful compaction still supersedes the previous brief", async () => {
    const { store } = await seeded();
    const sample = vi.fn<ModelCaller>(async () => ({ text: "1) DECISIONS new", truncated: false, finishReason: "endTurn" }));
    await runHandoff(input("sampling"), { store, config: loadConfig({ CAIRN_ENABLE_MODES: "sampling" }), sample });
    expect(store.currentState().filter((d) => d.decision === HANDOFF_DECISION_KEY).map((d) => d.rationale)).toEqual(["1) DECISIONS new"]);
  });
});
