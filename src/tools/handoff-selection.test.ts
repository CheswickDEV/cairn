import { describe, it, expect, vi } from "vitest";
import { runHandoff } from "./handoff.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { loadConfig } from "../core/config.js";
import { serverSampler } from "../core/sampling.js";
import { t } from "../i18n/index.js";
import { EgressNotConfiguredError, runOptionalCompaction, type ModelCaller, type ModelCallResult } from "../core/providers.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/* ADR-0012 stage 2: the selection decides which model compacts in the optional modes, and in account
   mode (the host wrote the brief) it becomes a recommendation. */

const store = () => new SqliteStore({ path: ":memory:" });
const echo = () => vi.fn<ModelCaller>(async (req) => ({ text: req.prompt, truncated: false, finishReason: "endTurn" }));

describe("bridge mode compacts with the selected model of the bridge CLI's ecosystem", () => {
  it.each([
    ["claude", { modelId: "claude-sonnet-5-5" }, "claude-opus-5-5"],
    ["claude", { modelId: "gpt-6.1-sol" }, "claude-opus-5-5"], // a Codex host with a claude bridge
    ["codex", { modelId: "claude-opus-5-5" }, "gpt-6.1-sol"], // a Claude host with a codex bridge
    ["codex", { modelId: "gpt-6-luna" }, "gpt-6.1-sol"],
  ] as const)("CAIRN_BRIDGE=%s, host %o → %s", async (cli, host, expected) => {
    const bridge = echo();
    const r = await runHandoff(
      { brief: "", source: "src", host, sourceZone: "red", mode: "bridge" },
      { store: store(), config: loadConfig({ CAIRN_ENABLE_MODES: "bridge", CAIRN_BRIDGE: cli }), bridge },
    );
    expect(bridge.mock.calls[0][0].model).toBe(expected);
    expect(r.modelId).toBe(expected);
    expect(r.compactedWith).toBe(expected);
    expect(r.recommendedModel).toBeUndefined();
  });

  it("after a verbatim fallback it keeps a host model of the bridge's ecosystem, never a foreign one", async () => {
    const run = async (cli: "claude" | "codex", modelId: string) => {
      const bridge = echo();
      const r = await runHandoff(
        { brief: "", source: "src", host: { modelId }, sourceZone: "red", mode: "bridge", fidelityFloor: 0.99 },
        { store: store(), config: loadConfig({ CAIRN_ENABLE_MODES: "bridge", CAIRN_BRIDGE: cli }), bridge },
      );
      expect(r.selectionKind).toBe("verbatim-fallback");
      return [bridge.mock.calls[0][0].model, r.compactedWith];
    };
    expect(await run("claude", "claude-sonnet-5-5")).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"]);
    expect(await run("claude", "gpt-6.1-sol")).toEqual(["", undefined]); // the CLI's own default model
  });
});

describe("sampling passes the selection as a model hint", () => {
  it("the request names the selected model, and the sampler sends it as modelPreferences.hints", async () => {
    const sample = echo();
    await runHandoff(
      { brief: "", source: "src", host: { modelId: "claude-sonnet-5-5" }, sourceZone: "green", mode: "sampling" },
      { store: store(), config: loadConfig({ CAIRN_ENABLE_MODES: "sampling" }), sample },
    );
    expect(sample.mock.calls[0][0].model).toBe("claude-opus-5-5");

    const createMessage = vi.fn(async (_params: unknown) => ({ content: { type: "text", text: "x" }, stopReason: "endTurn" }));
    const server = { server: { getClientCapabilities: () => ({ sampling: {} }), createMessage } } as unknown as McpServer;
    await serverSampler(server)({ prompt: "p", maxTokens: 10, model: "claude-opus-5-5" });
    expect((createMessage.mock.calls[0][0] as { modelPreferences?: unknown }).modelPreferences).toEqual({
      hints: [{ name: "claude-opus-5-5" }],
    });
    await serverSampler(server)({ prompt: "p", maxTokens: 10, model: "" });
    expect(createMessage.mock.calls[1][0]).not.toHaveProperty("modelPreferences");
  });
});

describe("account mode recommends the selected summarizer when another model wrote the brief", () => {
  const save = (host: { modelId?: string; provider?: string }) =>
    runHandoff({ brief: "1) DECISIONS x", host, sourceZone: "green" }, { store: store(), config: loadConfig({}) });

  it.each([
    [{ modelId: "claude-sonnet-5-5" }, "claude-opus-5-5"],
    [{ modelId: "claude-haiku-4-5-20251001" }, "claude-opus-5-5"],
    [{ modelId: "gpt-6-luna" }, "gpt-6.1-sol"],
    [{ provider: "anthropic" }, "claude-opus-5-5"], // writer unknown
  ] as const)("host %o → recommends %s, no model call", async (host, expected) => {
    const r = await save(host);
    expect(r.recommendedModel).toBe(expected);
    expect(r.egress).toBe(false);
    expect(r.compactedWith).toBeUndefined();
  });

  it.each([[{ modelId: "claude-opus-5-5[1m]" }], [{ modelId: "gpt-6.1-sol" }]] as const)(
    "host %o is the selected summarizer → no recommendation",
    async (host) => {
      expect((await save(host)).recommendedModel).toBeUndefined();
    },
  );

  it("the tool text names the writer and the recommended model (en, de)", () => {
    expect(t("en").handoff.recommend({ writer: "claude-sonnet-5-5", model: "Claude Opus 5.5" })).toContain(
      "Brief written by claude-sonnet-5-5. The most faithful summarizer here is Claude Opus 5.5",
    );
    expect(t("de").handoff.recommend({ model: "GPT-6.1 Sol" })).toContain("Der treueste Summarizer hier ist GPT-6.1 Sol");
  });
});

describe("API mode model fallbacks (ADR-0012)", () => {
  const api = async (provider: "anthropic" | "gemini", fidelityFloor?: number) => {
    const fetchFn = vi.fn(async () => ({
      json: async () =>
        provider === "gemini"
          ? { candidates: [{ content: { parts: [{ text: "1) DECISIONS x" }] }, finishReason: "STOP" }] }
          : { content: [{ type: "text", text: "1) DECISIONS x" }], stop_reason: "end_turn" },
    }));
    const config = {
      enabledModes: ["account", "api"] as const,
      endpoints: { main: { provider, baseUrl: "https://api.example.test", model: provider === "gemini" ? "gemini-x" : "claude-sonnet-5-5" } },
      storePath: ":memory:",
    };
    const r = await runHandoff(
      { brief: "", source: "src", host: { modelId: "claude-opus-4-8" }, sourceZone: "red", mode: "api", fidelityFloor },
      { store: store(), config: { ...config, enabledModes: [...config.enabledModes] }, fetchFn: fetchFn as never },
    );
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    return { r, url, body: JSON.parse(init.body as string) };
  };

  it("after a verbatim fallback the endpoint's default model compacts", async () => {
    const { r, body } = await api("anthropic", 0.99);
    expect(r.selectionKind).toBe("verbatim-fallback");
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(r.compactedWith).toBe("claude-sonnet-5-5");
  });

  it("an endpoint outside the pool (gemini) keeps its own default model", async () => {
    const { r, url } = await api("gemini");
    expect(url).toContain("/models/gemini-x:generateContent");
    expect(r.compactedWith).toBe("gemini-x");
  });

  const runApi = async (endpoint: { provider: "anthropic" | "openai" | "gemini"; model?: string }, modelId: string, fidelityFloor?: number) => {
    const fetchFn = vi.fn(async (_url: string, _init: RequestInit) => ({
      json: async () =>
        endpoint.provider === "gemini"
          ? { candidates: [{ content: { parts: [{ text: "1) DECISIONS x" }] }, finishReason: "STOP" }] }
          : endpoint.provider === "openai"
            ? { choices: [{ message: { content: "1) DECISIONS x" }, finish_reason: "stop" }] }
            : { content: [{ type: "text", text: "1) DECISIONS x" }], stop_reason: "end_turn" },
    }));
    const config = {
      enabledModes: ["account" as const, "api" as const],
      endpoints: { main: { baseUrl: "https://api.example.test", ...endpoint } },
      storePath: ":memory:",
    };
    const s = store();
    const run = runHandoff(
      { brief: "", source: "src", host: { modelId }, sourceZone: "red", mode: "api", fidelityFloor },
      { store: s, config, fetchFn: fetchFn as never },
    );
    return { run, fetchFn, s };
  };

  it("a configured endpoint model wins over the selection (a gateway or an Azure deployment names its own models)", async () => {
    const { run, fetchFn } = await runApi({ provider: "openai", model: "my-azure-deployment" }, "gpt-6-luna");
    const r = await run;
    expect(r.modelId).toBe("gpt-6.1-sol"); // still selected and reported
    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect(body.model).toBe("my-azure-deployment");
    expect(body).not.toHaveProperty("reasoning_effort"); // not a pool id: the provider default
    expect(r.compactedWith).toBe("my-azure-deployment");
  });

  it("an endpoint model of the other ecosystem gets no effort (an OpenAI-compatible gateway serving Claude)", async () => {
    const { run, fetchFn } = await runApi({ provider: "openai", model: "claude-opus-5-5" }, "gpt-6-luna");
    const r = await run;
    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect(body.model).toBe("claude-opus-5-5");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(6_144);
    expect(r.compactedWith).toBe("claude-opus-5-5");
    const same = await runApi({ provider: "openai", model: "gpt-6.1-sol" }, "gpt-6-luna");
    await same.run;
    expect(JSON.parse(same.fetchFn.mock.calls[0][1].body as string).reasoning_effort).toBe("high");
  });

  it("without any model id the API call is refused before egress, never sent with an empty model", async () => {
    const { run, fetchFn, s } = await runApi({ provider: "anthropic" }, "gpt-6.1-sol", 0.99);
    await expect(run).rejects.toThrow(EgressNotConfiguredError);
    await expect(run).rejects.toThrow(/no model for endpoint 'main'/);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(s.currentState()).toEqual([]);
  });

  it("the guardrail reports a disabled mode or a missing endpoint before a missing model", async () => {
    const request = { prompt: "p", maxTokens: 10, model: "" };
    const endpoints = { main: { provider: "anthropic" as const, baseUrl: "https://api.example.test" } };
    const off = { enabledModes: ["account" as const], endpoints, storePath: ":memory:" };
    await expect(runOptionalCompaction({ mode: "api", config: off, request, endpointKey: "main" })).rejects.toThrow(/not enabled/);
    const on = { ...off, enabledModes: ["account" as const, "api" as const] };
    await expect(runOptionalCompaction({ mode: "api", config: on, request, endpointKey: "x" })).rejects.toThrow(/no endpoint 'x'/);
    await expect(runOptionalCompaction({ mode: "api", config: on, request, endpointKey: "main" })).rejects.toThrow(/no model for endpoint 'main'/);
  });

  it("a gemini endpoint gets no effort budget from a pool host id", async () => {
    const { run, fetchFn } = await runApi({ provider: "gemini" }, "claude-opus-5-5");
    await run;
    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect(body.generationConfig.maxOutputTokens).toBe(6_144); // dynamicMaxTokens(4096 × 1.5, cap 8192), not 32000
  });
});

describe("the brief is credited to the model that answered (ADR-0012)", () => {
  const bridgeRun = async (answer: Partial<ModelCallResult>, floor?: number, modelId = "gpt-6.1-sol") => {
    const s = store();
    const bridge = vi.fn<ModelCaller>(async () => ({ text: "1) DECISIONS x", truncated: false, finishReason: "success", ...answer }));
    const r = await runHandoff(
      {
        brief: "",
        source: "src",
        host: { modelId },
        sourceZone: "red",
        mode: "bridge",
        fidelityFloor: floor,
        decisions: [{ decision: "d", rationale: "r" }],
      },
      { store: s, config: loadConfig({ CAIRN_ENABLE_MODES: "bridge", CAIRN_BRIDGE: "claude" }), bridge },
    );
    const who = s.currentState().map((d) => [d.decision, d.who]);
    return { r, who };
  };

  it("the requested model when the caller reports only it (snapshot suffix allowed)", async () => {
    const { r, who } = await bridgeRun({ modelsUsed: ["claude-opus-5-5-20260922"] });
    expect(r.compactedWith).toBe("claude-opus-5-5");
    expect(who.find(([d]) => d !== "d")?.[1]).toBe("claude-opus-5-5");
  });

  it("the answering model after a fallback or a codex reroute; host decisions keep the host as author", async () => {
    const { r, who } = await bridgeRun({ modelsUsed: ["claude-sonnet-5-5"] });
    expect(r.compactedWith).toBe("claude-sonnet-5-5");
    expect(who.find(([d]) => d !== "d")?.[1]).toBe("claude-sonnet-5-5");
    expect(who).toContainEqual(["d", "gpt-6.1-sol"]); // the host's own structured decision
    const mixed = await bridgeRun({ modelsUsed: ["claude-opus-5-5", "claude-haiku-5-5"] });
    expect(mixed.r.compactedWith).toBe("claude-opus-5-5, claude-haiku-5-5");
  });

  it("the CLI's default model when nothing was requested and the CLI names it", async () => {
    const { r } = await bridgeRun({ modelsUsed: ["claude-sonnet-5-5"] }, 0.99);
    expect(r.selectionKind).toBe("verbatim-fallback");
    expect(r.compactedWith).toBe("claude-sonnet-5-5");
    const none = await bridgeRun({}, 0.99);
    expect(none.r.compactedWith).toBeUndefined();
    expect(none.who.every(([, w]) => w === "gpt-6.1-sol")).toBe(true); // unknown author: the host, as before
  });

  it("sampling credits the client's reported model, never the hint", async () => {
    const run = async (model?: string) => {
      const s = store();
      const createMessage = vi.fn(async () => ({ content: { type: "text", text: "1) DECISIONS x" }, stopReason: "endTurn", ...(model !== undefined ? { model } : {}) }));
      const server = { server: { getClientCapabilities: () => ({ sampling: {} }), createMessage } } as unknown as McpServer;
      const r = await runHandoff(
        { brief: "", source: "src", host: { modelId: "claude-sonnet-5-5" }, sourceZone: "green", mode: "sampling" },
        { store: s, config: loadConfig({ CAIRN_ENABLE_MODES: "sampling" }), sample: serverSampler(server) },
      );
      return { r, who: s.getDecision(r.storedDecisionId)?.who };
    };
    expect(await run("claude-sonnet-5-5")).toMatchObject({ r: { compactedWith: "claude-sonnet-5-5" }, who: "claude-sonnet-5-5" });
    expect(await run("claude-opus-5-5")).toMatchObject({ r: { compactedWith: "claude-opus-5-5" }, who: "claude-opus-5-5" });
    const unreported = await run();
    expect(unreported.r.compactedWith).toBeUndefined();
    expect(unreported.who).toBe("claude-sonnet-5-5");
    expect((await run("  ")).r.compactedWith).toBeUndefined();
  });

  it("a decorated requested id (`[1m]`) and the plain id the client reports name the same model", async () => {
    const s = store();
    const createMessage = vi.fn(async () => ({ content: { type: "text", text: "1) DECISIONS x" }, stopReason: "endTurn", model: "claude-opus-5-5" }));
    const server = { server: { getClientCapabilities: () => ({ sampling: {} }), createMessage } } as unknown as McpServer;
    const r = await runHandoff(
      { brief: "", source: "src", host: { modelId: "claude-opus-5-5[1m]" }, sourceZone: "green", mode: "sampling", fidelityFloor: 0.99 },
      { store: s, config: loadConfig({ CAIRN_ENABLE_MODES: "sampling" }), sample: serverSampler(server) },
    );
    expect(r.selectionKind).toBe("verbatim-fallback");
    expect(r.compactedWith).toBe("claude-opus-5-5[1m]");
  });
});
