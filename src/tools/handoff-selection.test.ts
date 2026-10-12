import { describe, it, expect, vi } from "vitest";
import { runHandoff } from "./handoff.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { loadConfig } from "../core/config.js";
import { serverSampler } from "../core/sampling.js";
import { t } from "../i18n/index.js";
import type { ModelCaller } from "../core/providers.js";
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
});
