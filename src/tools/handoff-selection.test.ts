import { describe, it, expect, vi } from "vitest";
import { runHandoff, registerHandoff, recommendationLine, type HandoffInput } from "./handoff.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { loadConfig } from "../core/config.js";
import { serverSampler } from "../core/sampling.js";
import { t } from "../i18n/index.js";
import { EgressNotConfiguredError, runOptionalCompaction, type ModelCaller, type ModelCallResult } from "../core/providers.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/* ADR-0012: the session model writes the brief in every mode (user decision, 2026-10-12); an API endpoint's
   configured model wins. The selection becomes a recommendation whenever it names another model. */

const store = () => new SqliteStore({ path: ":memory:" });
const echo = () => vi.fn<ModelCaller>(async (req) => ({ text: req.prompt, truncated: false, finishReason: "endTurn" }));

describe("bridge mode compacts with the session model where it runs, else the CLI's default", () => {
  it.each([
    ["claude", { modelId: "claude-sonnet-5-5" }, "claude-sonnet-5-5", "claude-opus-5-5"],
    ["claude", { modelId: "claude-opus-5-5[1m]" }, "claude-opus-5-5[1m]", undefined],
    ["claude", { modelId: "gpt-6.1-sol" }, "", "claude-opus-5-5"], // a Codex host with a claude bridge
    ["claude", { provider: "anthropic" }, "", "claude-opus-5-5"], // session model unknown
    ["codex", { modelId: "claude-opus-5-5" }, "", "gpt-6.1-sol"], // a Claude host with a codex bridge
    ["codex", { modelId: "gpt-6-luna" }, "gpt-6-luna", "gpt-6.1-sol"],
    ["codex", { modelId: "gpt-6.1-sol" }, "gpt-6.1-sol", undefined],
    ["claude", { modelId: "gpt-6-luna", provider: "anthropic" }, "", "claude-opus-5-5"], // the id wins over a contradicting provider
    ["claude", { modelId: "opus", provider: "anthropic" }, "opus", "claude-opus-5-5"], // an alias: the provider decides
  ] as const)("CAIRN_BRIDGE=%s, host %o → asks for %j, recommends %s", async (cli, host, asked, recommended) => {
    const bridge = echo();
    const r = await runHandoff(
      { brief: "", source: "src", host, sourceZone: "red", mode: "bridge" },
      { store: store(), config: loadConfig({ CAIRN_ENABLE_MODES: "bridge", CAIRN_BRIDGE: cli }), bridge },
    );
    expect(bridge.mock.calls[0][0].model).toBe(asked);
    expect(r.compactedWith).toBe(asked || undefined);
    expect(r.modelId).toBe(cli === "claude" ? "claude-opus-5-5" : "gpt-6.1-sol"); // selected in the bridge's ecosystem
    expect(r.recommendedModel).toBe(recommended);
  });

  it("a verbatim fallback changes nothing about the model and recommends nothing", async () => {
    const bridge = echo();
    const r = await runHandoff(
      { brief: "", source: "src", host: { modelId: "claude-sonnet-5-5" }, sourceZone: "red", mode: "bridge", fidelityFloor: 0.99 },
      { store: store(), config: loadConfig({ CAIRN_ENABLE_MODES: "bridge", CAIRN_BRIDGE: "claude" }), bridge },
    );
    expect(r.selectionKind).toBe("verbatim-fallback");
    expect([bridge.mock.calls[0][0].model, r.compactedWith, r.recommendedModel]).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5", undefined]);
  });
});

describe("sampling names the session model as the hint", () => {
  it("the request names the host's model, and the sampler sends it as modelPreferences.hints", async () => {
    const sample = echo();
    const r = await runHandoff(
      { brief: "", source: "src", host: { modelId: "claude-sonnet-5-5" }, sourceZone: "green", mode: "sampling" },
      { store: store(), config: loadConfig({ CAIRN_ENABLE_MODES: "sampling" }), sample },
    );
    expect(sample.mock.calls[0][0].model).toBe("claude-sonnet-5-5");
    // The client named no model: the writer is unknown, so the selection is recommended.
    expect(r.compactedWith).toBeUndefined();
    expect(r.recommendedModel).toBe("claude-opus-5-5");

    const createMessage = vi.fn(async (_params: unknown) => ({ content: { type: "text", text: "x" }, stopReason: "endTurn" }));
    const server = { server: { getClientCapabilities: () => ({ sampling: {} }), createMessage } } as unknown as McpServer;
    await serverSampler(server)({ prompt: "p", maxTokens: 10, model: "claude-sonnet-5-5" });
    expect((createMessage.mock.calls[0][0] as { modelPreferences?: unknown }).modelPreferences).toEqual({
      hints: [{ name: "claude-sonnet-5-5" }],
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
    [{ provider: "anthropic" }, "claude-opus-5-5"], // writer unknown: recommended, worded conditionally
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
});

describe("the recommendation text follows where the writing model came from", () => {
  it("session model known, unknown, an endpoint's model, a bridge CLI's default (en, de)", () => {
    const en = t("en").handoff.recommend;
    const de = t("de").handoff.recommend;
    expect(en({ writer: "claude-sonnet-5-5", model: "Claude Opus 5.5", source: "session" })).toBe(
      "Brief written by claude-sonnet-5-5. The most faithful summarizer here is Claude Opus 5.5: " +
        "switch the session model (/model) and run Cairn Handoff again for the best brief.",
    );
    expect(de({ model: "GPT-6.1 Sol", source: "session" })).toBe(
      "Der treueste Summarizer hier ist GPT-6.1 Sol. Läuft die Session auf einem anderen Modell: " +
        "wechseln (/model) und Cairn Handoff erneut ausführen, für den besten Brief.",
    );
    expect(en({ writer: "my-deployment", model: "GPT-6.1 Sol", source: "endpoint", endpoint: "main" })).toContain(
      "Brief written by my-deployment, the model set for endpoint 'main'. The most faithful summarizer here is GPT-6.1 Sol: " +
        "if that endpoint runs another model, set it to GPT-6.1 Sol",
    );
    expect(de({ model: "GPT-6.1 Sol", source: "cli", cli: "codex" })).toBe(
      "Brief geschrieben von dem Standardmodell der codex-CLI, das die Bridge ohne ein Session-Modell ihres Ökosystems " +
        "nutzt. Der treueste Summarizer hier ist GPT-6.1 Sol.",
    );
    for (const p of [{ source: "endpoint", writer: "w", endpoint: "e" }, { source: "cli", cli: "claude" }] as const) {
      expect(en({ model: "M", ...p })).not.toContain("/model");
      expect(de({ model: "M", ...p })).not.toContain("/model");
    }
  });

  it("recommendationLine picks the variant from the mode and the configuration", async () => {
    const line = async (input: HandoffInput, env: Record<string, string>, lang: "en" | "de" = "en") => {
      const config = loadConfig(env);
      const caller = echo();
      const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "1) DECISIONS x" }, finish_reason: "stop" }] }) }));
      const r = await runHandoff(input, { store: store(), config, bridge: caller, sample: caller, fetchFn: fetchFn as never });
      return recommendationLine(r, input, config, lang);
    };
    expect(await line({ brief: "x", host: { provider: "anthropic" }, sourceZone: "green" }, {})).toMatch(
      /^The most faithful summarizer here is Claude Opus 5\.5\. If the session runs another model/,
    );
    expect(await line({ brief: "x", host: { modelId: "claude-sonnet-5-5" }, sourceZone: "green" }, {}, "de")).toMatch(
      /^Brief geschrieben von claude-sonnet-5-5\. Der treueste Summarizer hier ist Claude Opus 5\.5: Session-Modell wechseln/,
    );
    const bridgeEnv = { CAIRN_ENABLE_MODES: "bridge", CAIRN_BRIDGE: "codex" };
    expect(await line({ brief: "", source: "s", host: { modelId: "claude-opus-5-5" }, sourceZone: "red", mode: "bridge" }, bridgeEnv)).toBe(
      "Brief written by the codex CLI's default model, which the bridge uses without a session model of its ecosystem. " +
        "The most faithful summarizer here is GPT-6.1 Sol.",
    );
    expect(await line({ brief: "", source: "s", host: { modelId: "gpt-6-luna" }, sourceZone: "red", mode: "bridge" }, bridgeEnv)).toMatch(
      /^Brief written by gpt-6-luna\. The most faithful summarizer here is GPT-6\.1 Sol: switch the session model/,
    );
    const apiEnv = { CAIRN_ENABLE_MODES: "api", CAIRN_ENDPOINT_MAIN: "openai|https://api.example.test|KEY|my-deployment" };
    expect(await line({ brief: "", source: "s", host: { modelId: "gpt-6-luna" }, sourceZone: "red", mode: "api" }, apiEnv)).toMatch(
      /^Brief written by my-deployment, the model set for endpoint 'main'\./,
    );
    expect(await line({ brief: "", source: "s", host: { modelId: "gpt-6-luna" }, sourceZone: "red", mode: "sampling" }, { CAIRN_ENABLE_MODES: "sampling" })).toMatch(
      /^The most faithful summarizer here is GPT-6\.1 Sol\. If the session runs another model/,
    );
  });
});

describe("the tool text", () => {
  const toolText = async (host: { modelId?: string }) => {
    let handler: ((args: unknown) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    const server = { registerTool: (_n: string, _d: unknown, h: typeof handler) => (handler = h) } as unknown as McpServer;
    registerHandoff(server, { store: store(), config: loadConfig({ CAIRN_ENABLE_MODES: "bridge", CAIRN_BRIDGE: "claude" }), bridge: echo() });
    return (await handler!({ brief: "", source: "src", host, sourceZone: "red", mode: "bridge" })).content[0].text;
  };

  it("no recommendation when the sampling hint already is the selection, even if the client names no model", async () => {
    const sample = echo(); // reports no model: the writer is unknown
    const r = await runHandoff(
      { brief: "", source: "src", host: { modelId: "gpt-6.1-sol" }, sourceZone: "red", mode: "sampling" },
      { store: store(), config: loadConfig({ CAIRN_ENABLE_MODES: "sampling" }), sample },
    );
    expect([sample.mock.calls[0][0].model, r.compactedWith, r.recommendedModel]).toEqual(["gpt-6.1-sol", undefined, undefined]);
  });

  it("no recommendation when the session model already is the selection and a fallback answered", async () => {
    const bridge = vi.fn<ModelCaller>(async () => ({ text: "1) DECISIONS x", truncated: false, finishReason: "success", modelsUsed: ["claude-sonnet-5-5"] }));
    const r = await runHandoff(
      { brief: "", source: "src", host: { modelId: "claude-opus-5-5" }, sourceZone: "red", mode: "bridge" },
      { store: store(), config: loadConfig({ CAIRN_ENABLE_MODES: "bridge", CAIRN_BRIDGE: "claude" }), bridge },
    );
    expect(r.compactedWith).toBe("claude-sonnet-5-5"); // named in the result instead
    expect(r.recommendedModel).toBeUndefined();
  });

  it("names the writer once: in the recommendation when there is one, else as 'Compacted with'", async () => {
    const recommended = await toolText({ modelId: "claude-sonnet-5-5" });
    expect(recommended).toContain("Brief written by claude-sonnet-5-5. The most faithful summarizer here is Claude Opus 5.5");
    expect(recommended).not.toContain("Compacted with");
    const best = await toolText({ modelId: "claude-opus-5-5" });
    expect(best).toContain("Compacted with claude-opus-5-5.");
    expect(best).not.toContain("most faithful");
  });
});

describe("API mode model fallbacks (ADR-0012)", () => {
  const api = async (provider: "anthropic" | "gemini", fidelityFloor?: number) => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
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

  it("an endpoint outside the pool (gemini) keeps its own default model, and nothing is recommended for it", async () => {
    const { r, url } = await api("gemini");
    expect(url).toContain("/models/gemini-x:generateContent");
    expect(r.compactedWith).toBe("gemini-x");
    expect(r.modelId).toBe("claude-opus-5-5"); // the host's ecosystem: no model the endpoint runs
    expect(r.recommendedModel).toBeUndefined();
  });

  const runApi = async (endpoint: { provider: "anthropic" | "openai" | "gemini"; model?: string }, modelId: string, fidelityFloor?: number) => {
    const fetchFn = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
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

  it("a configured endpoint model wins over the session model (a gateway or an Azure deployment names its own models)", async () => {
    const { run, fetchFn } = await runApi({ provider: "openai", model: "my-azure-deployment" }, "gpt-6-luna");
    const r = await run;
    expect(r.modelId).toBe("gpt-6.1-sol"); // still selected and reported
    expect(r.recommendedModel).toBe("gpt-6.1-sol");
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
    expect(body.max_tokens).toBe(6_144); // not an OpenAI model: the field OpenAI-compatible servers read
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(r.compactedWith).toBe("claude-opus-5-5");
    const same = await runApi({ provider: "openai", model: "gpt-6.1-sol" }, "gpt-6-luna");
    await same.run;
    expect(JSON.parse(same.fetchFn.mock.calls[0][1].body as string).reasoning_effort).toBe("high");
  });

  it("an endpoint without a model uses the session model of its provider", async () => {
    const { run, fetchFn } = await runApi({ provider: "openai" }, "gpt-6-luna");
    const r = await run;
    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect([body.model, body.reasoning_effort, r.compactedWith, r.recommendedModel]).toEqual(["gpt-6-luna", "high", "gpt-6-luna", "gpt-6.1-sol"]);
    // At `high` the raised budget goes out as max_completion_tokens, which also bounds the reasoning tokens.
    expect(body.max_completion_tokens).toBe(32_000);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("the session model goes to the API without Claude Code's context suffix", async () => {
    const { run, fetchFn } = await runApi({ provider: "anthropic" }, "claude-sonnet-5-5[1m]");
    const r = await run;
    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect([body.model, body.output_config?.effort, r.compactedWith]).toEqual(["claude-sonnet-5-5", "high", "claude-sonnet-5-5"]);
    const configured = await runApi({ provider: "anthropic", model: "claude-opus-5-5[1m]" }, "claude-sonnet-5-5");
    await configured.run;
    expect(JSON.parse(configured.fetchFn.mock.calls[0][1].body as string).model).toBe("claude-opus-5-5[1m]"); // the user's own setting
  });

  it("without any model id the API call is refused before egress, never sent with an empty model", async () => {
    // A session model of the other provider does not run there, and the selection never fills the gap.
    const { run, fetchFn, s } = await runApi({ provider: "anthropic" }, "gpt-6.1-sol");
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
  const bridgeRun = async (answer: Partial<ModelCallResult>, modelId = "claude-opus-5-5") => {
    const s = store();
    const bridge = vi.fn<ModelCaller>(async () => ({ text: "1) DECISIONS x", truncated: false, finishReason: "success", ...answer }));
    const r = await runHandoff(
      {
        brief: "",
        source: "src",
        host: { modelId },
        sourceZone: "red",
        mode: "bridge",
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
    expect(who).toContainEqual(["d", "claude-opus-5-5"]); // the host's own structured decision
    const mixed = await bridgeRun({ modelsUsed: ["claude-opus-5-5", "claude-haiku-5-5"] });
    expect(mixed.r.compactedWith).toBe("claude-opus-5-5, claude-haiku-5-5");
  });

  it("the CLI's default model when nothing was requested and the CLI names it", async () => {
    // A Codex host with a claude bridge: its session model does not run there, so nothing is requested.
    const { r } = await bridgeRun({ modelsUsed: ["claude-sonnet-5-5"] }, "gpt-6.1-sol");
    expect(r.compactedWith).toBe("claude-sonnet-5-5");
    expect(r.recommendedModel).toBe("claude-opus-5-5");
    const none = await bridgeRun({}, "gpt-6.1-sol");
    expect(none.r.compactedWith).toBeUndefined();
    expect(none.who.every(([, w]) => w === "gpt-6.1-sol")).toBe(true); // unknown author: the host, as before
  });

  it("sampling credits the client's reported model, never the hint alone", async () => {
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
