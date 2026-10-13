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

/* ADR-0012: a compaction call that failed, was stopped by the provider or returned no text stores nothing -
   no brief, no decision, no evidence - so the previous brief stays current. */

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

  it("a body without a message (no JSON, null, no string) still fails, with the status only", async () => {
    for (const body of ["<html>Bad Gateway</html>", "null", "{}", JSON.stringify({ error: { message: 42 } })]) {
      await expect(callAnthropic({ ...ep, provider: "anthropic" }, req, res(502, body) as never, {})).rejects.toThrow(
        /^anthropic API returned HTTP 502$/,
      );
    }
  });

  it("takes a plain string in `error` and keeps at most 300 characters of the message", async () => {
    await expect(callOpenAICompatible({ ...ep, provider: "openai" }, req, res(429, JSON.stringify({ error: "quota exceeded" })) as never, {})).rejects.toThrow(
      /^openai API returned HTTP 429: quota exceeded$/,
    );
    const long = "x".repeat(400);
    const err = await callGemini({ ...ep, provider: "gemini" }, req, res(500, JSON.stringify({ error: { message: long } })) as never, {}).catch((e: Error) => e);
    expect((err as Error).message).toBe(`gemini API returned HTTP 500: ${"x".repeat(300)}`);
  });
});

describe("the API adapters flag an answer the provider stopped short of a regular end", () => {
  const call = { anthropic: callAnthropic, openai: callOpenAICompatible, gemini: callGemini } as const;
  const anth = (stop_reason?: string) => ({ content: [{ type: "text", text: "1) DECISIONS par" }], ...(stop_reason ? { stop_reason } : {}) });
  const oai = (finish_reason: string) => ({ choices: [{ message: { content: "x" }, finish_reason }] });
  const gem = (finishReason?: string | null) => ({ candidates: [{ content: { parts: [{ text: "x" }] }, ...(finishReason !== undefined ? { finishReason } : {}) }] });
  it.each([
    ["anthropic", anth("refusal"), true],
    ["anthropic", anth("end_turn"), false],
    ["anthropic", anth("max_tokens"), false],
    ["anthropic", anth("stop_sequence"), false],
    ["anthropic", anth(), false], // no stop reason given
    ["openai", oai("content_filter"), true],
    ["openai", oai("stop"), false],
    ["openai", oai("length"), false],
    ["openai", oai("tool_calls"), false],
    // A refusal comes in `message.refusal`, not as a finish reason.
    ["openai", { choices: [{ message: { content: null, refusal: "I can't help with that." }, finish_reason: "stop" }] }, true],
    ["openai", { choices: [{ message: { content: "x", refusal: null }, finish_reason: "stop" }] }, false],
    ["openai", { choices: [{ message: { content: "x", refusal: " " }, finish_reason: "stop" }] }, false],
    ["gemini", gem("SAFETY"), true],
    ["gemini", gem("RECITATION"), true],
    ["gemini", gem("OTHER"), true],
    ["gemini", gem("PROHIBITED_CONTENT"), true],
    ["gemini", gem("BLOCKLIST"), true],
    ["gemini", gem("STOP"), false],
    ["gemini", gem("MAX_TOKENS"), false],
    ["gemini", gem("FINISH_REASON_UNSPECIFIED"), false], // documented as unused
    ["gemini", gem(), false], // no finish reason: the model has not stopped
    ["gemini", gem(null), false],
    // A blocked prompt gets no candidates, only a block reason.
    ["gemini", { promptFeedback: { blockReason: "SAFETY" } }, true],
    ["gemini", { promptFeedback: { blockReason: "OTHER" }, candidates: [] }, true],
    ["gemini", { ...gem("STOP"), promptFeedback: { blockReason: "BLOCK_REASON_UNSPECIFIED" } }, false], // documented as unused
    ["gemini", { ...gem("STOP"), promptFeedback: { safetyRatings: [] } }, false],
    ["gemini", { ...gem("STOP"), promptFeedback: null }, false],
  ] as const)("%s %j → blocked %s", async (provider, body, blocked) => {
    const r = await call[provider]({ ...ep, provider }, req, res(200, JSON.stringify(body)) as never, {});
    expect(r.blocked === true).toBe(blocked);
  });
});

describe("a failed or empty compaction stores nothing; the previous brief stays current", () => {
  /** A store holding a superseded and a current brief, a host decision and evidence. */
  const seeded = async () => {
    const store = new SqliteStore({ path: ":memory:" });
    await runHandoff({ brief: "1) DECISIONS older brief", host: { modelId: "claude-opus-5-5" }, sourceZone: "green" }, { store, config: loadConfig({}) });
    await runHandoff(
      { brief: "1) DECISIONS earlier brief", host: { modelId: "claude-opus-5-5" }, sourceZone: "green", decisions: [{ decision: "keep", rationale: "r" }] },
      { store, config: loadConfig({}) },
    );
    store.addEvidence({ decisionId: store.currentState()[0].decisionId, claim: "seed", sourceRef: "s", type: "msg", verbatim: null });
    expect(store.queryDecisions().filter((d) => d.status === "superseded").map((d) => d.rationale)).toEqual(["1) DECISIONS older brief"]);
    return { store, before: dump(store) };
  };
  /** Every decision row (superseded ones too) with its evidence. */
  const dump = (store: SqliteStore) =>
    JSON.stringify(store.queryDecisions().map((d) => ({ ...d, evidence: store.getEvidence(d.decisionId) })));
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
    expect(dump(store)).toBe(before);
    expect(store.currentState().filter((d) => d.decision === HANDOFF_DECISION_KEY).map((d) => d.rationale)).toEqual(["1) DECISIONS earlier brief"]);
  };

  it("API: an HTTP error and a 200 without text", async () => {
    const config: CairnConfig = {
      enabledModes: ["account", "api"],
      endpoints: { main: { provider: "anthropic", baseUrl: "https://api.example.test" } },
      storePath: ":memory:",
    };
    for (const [fetchFn, reason] of [
      [
        res(529, JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })),
        /^api compaction failed: anthropic API returned HTTP 529: Overloaded; nothing stored, the previous brief stays current$/,
      ],
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

  it("API: an answer the provider stopped (refusal, content filter, Gemini SAFETY), partial text or not", async () => {
    const cases = [
      ["anthropic", { content: [{ type: "text", text: "1) DECISIONS par" }], stop_reason: "refusal" }, /^api compaction was stopped \(refusal\): 1\) DECISIONS par; nothing stored/],
      // The reported text is cut to 300 characters.
      ["anthropic", { content: [{ type: "text", text: `  ${"y".repeat(400)}` }], stop_reason: "refusal" }, new RegExp(`^api compaction was stopped \\(refusal\\): ${"y".repeat(300)}; nothing stored`)],
      ["openai", { choices: [{ message: { content: "1) DEC" }, finish_reason: "content_filter" }] }, /^api compaction was stopped \(content_filter\): 1\) DEC; nothing/],
      ["gemini", { candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "SAFETY" }] }, /^api compaction was stopped \(SAFETY\); nothing stored/],
      // A refusal is reported with its text; a blocked prompt with its block reason.
      ["openai", { choices: [{ message: { content: null, refusal: "I can't help with that." }, finish_reason: "stop" }] }, /^api compaction was stopped \(refusal\): I can't help with that\.; nothing stored/],
      ["openai", { choices: [{ message: { content: "1) DEC part", refusal: "No." }, finish_reason: "stop" }] }, /^api compaction was stopped \(refusal\): No\.; nothing stored/],
      ["gemini", { promptFeedback: { blockReason: "PROHIBITED_CONTENT", safetyRatings: [] } }, /^api compaction was stopped \(prompt blocked: PROHIBITED_CONTENT\); nothing stored/],
    ] as const;
    for (const [provider, body, reason] of cases) {
      const config: CairnConfig = {
        enabledModes: ["account", "api"],
        endpoints: { main: { provider, baseUrl: "https://api.example.test", model: "m" } },
        storePath: ":memory:",
      };
      const { store, before } = await seeded();
      const run = runHandoff(input("api"), { store, config, fetchFn: res(200, JSON.stringify(body)) as never });
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
      // claude output that is no JSON object is no answer, also with exit 0 (a wrapper, a changed format).
      ["claude", "claude-opus-5-5", "1) DECISIONS printed by a wrapper", /^bridge compaction failed: 1\) DECISIONS printed by a wrapper; nothing stored/],
      ["claude", "claude-opus-5-5", "null", /^bridge compaction failed: null; nothing stored/],
      ["claude", "claude-opus-5-5", `${JSON.stringify({ type: "result", subtype: "success", result: "1) DECISIONS x" })}\nwarning`, /^bridge compaction failed: \{"type":"result"/],
      // An `error_*` result fails even with `is_error: false`; its messages are in `errors`, also in the array form.
      [
        "claude",
        "claude-opus-5-5",
        JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: false, errors: ["turn stopped", 7, "no calls ran"] }),
        /^bridge compaction failed: turn stopped; no calls ran; nothing stored/,
      ],
      [
        "claude",
        "claude-opus-5-5",
        JSON.stringify([{ type: "system" }, { type: "result", subtype: "error_max_turns", is_error: false, errors: ["Reached maximum number of turns (1)"] }]),
        /^bridge compaction failed: Reached maximum number of turns \(1\); nothing stored/,
      ],
      // `errors` of a result that did not fail is no brief either.
      ["claude", "claude-opus-5-5", JSON.stringify({ type: "result", subtype: "success", errors: ["x"] }), /^bridge compaction returned no text; nothing stored/],
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

  it("a truncated answer with text is still stored (API and sampling)", async () => {
    const config: CairnConfig = {
      enabledModes: ["account", "api", "sampling"],
      endpoints: { main: { provider: "anthropic", baseUrl: "https://api.example.test" } },
      storePath: ":memory:",
    };
    const api = await seeded();
    const fetchFn = res(200, JSON.stringify({ content: [{ type: "text", text: "1) DECISIONS cut" }], stop_reason: "max_tokens" }));
    await runHandoff(input("api"), { store: api.store, config, fetchFn: fetchFn as never });
    expect(api.store.currentState().filter((d) => d.decision === HANDOFF_DECISION_KEY).map((d) => d.rationale)).toEqual(["1) DECISIONS cut"]);
    const smp = await seeded();
    const sample = vi.fn<ModelCaller>(async () => ({ text: "1) DECISIONS cut too", truncated: true, finishReason: "maxTokens" }));
    await runHandoff(input("sampling"), { store: smp.store, config, sample });
    expect(smp.store.currentState().filter((d) => d.decision === HANDOFF_DECISION_KEY).map((d) => d.rationale)).toEqual(["1) DECISIONS cut too"]);
  });

  it("account mode is unchanged: it stores the host's brief as given, also an empty one", async () => {
    const { store } = await seeded();
    const r = await runHandoff({ brief: "", host: { modelId: "claude-opus-5-5" }, sourceZone: "green" }, { store, config: loadConfig({}) });
    expect(r.egress).toBe(false);
    expect(store.currentState().filter((d) => d.decision === HANDOFF_DECISION_KEY).map((d) => d.rationale)).toEqual([""]);
  });

  it("a successful compaction still supersedes the previous brief", async () => {
    const { store } = await seeded();
    const sample = vi.fn<ModelCaller>(async () => ({ text: "1) DECISIONS new", truncated: false, finishReason: "endTurn" }));
    await runHandoff(input("sampling"), { store, config: loadConfig({ CAIRN_ENABLE_MODES: "sampling" }), sample });
    expect(store.currentState().filter((d) => d.decision === HANDOFF_DECISION_KEY).map((d) => d.rationale)).toEqual(["1) DECISIONS new"]);
  });
});
