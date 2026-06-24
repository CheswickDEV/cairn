import { describe, it, expect, vi } from "vitest";
import {
  runOptionalCompaction,
  EgressNotConfiguredError,
  dynamicMaxTokens,
  callAnthropic,
  callOpenAICompatible,
} from "./providers.js";
import { loadConfig, type CairnConfig } from "./config.js";

const baseReq = { prompt: "compact this", maxTokens: 1024, model: "m" };

describe("egress guardrail (ADR-0006)", () => {
  it("never calls fetch in the default (account-only) config", async () => {
    const fetchSpy = vi.fn();
    const config = loadConfig({}); // default: account only, no endpoints
    await expect(
      runOptionalCompaction({ mode: "api", config, endpointKey: "x", request: baseReq, fetchFn: fetchSpy }),
    ).rejects.toBeInstanceOf(EgressNotConfiguredError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses 'account' mode on the egress path (account never egresses)", async () => {
    const fetchSpy = vi.fn();
    const config = loadConfig({});
    await expect(
      runOptionalCompaction({ mode: "account", config, endpointKey: "x", request: baseReq, fetchFn: fetchSpy }),
    ).rejects.toBeInstanceOf(EgressNotConfiguredError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an enabled mode when the named endpoint is not configured", async () => {
    const fetchSpy = vi.fn();
    const config: CairnConfig = { enabledModes: ["account", "api"], endpoints: {}, storePath: ":memory:" };
    await expect(
      runOptionalCompaction({ mode: "api", config, endpointKey: "missing", request: baseReq, fetchFn: fetchSpy }),
    ).rejects.toBeInstanceOf(EgressNotConfiguredError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("only egresses to a fully-configured + explicitly-enabled endpoint", async () => {
    const fetchSpy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "ok brief" }], stop_reason: "end_turn" }), {
        status: 200,
      }),
    );
    const config: CairnConfig = {
      enabledModes: ["account", "api"],
      endpoints: { eu: { provider: "anthropic", baseUrl: "https://bedrock.eu.example", apiKeyEnv: "K" } },
      storePath: ":memory:",
    };
    const r = await runOptionalCompaction({
      mode: "api",
      config,
      endpointKey: "eu",
      request: baseReq,
      fetchFn: fetchSpy,
      env: { K: "secret" },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://bedrock.eu.example/v1/messages");
    expect(r.text).toBe("ok brief");
    expect(r.truncated).toBe(false);
  });
});

describe("loadConfig", () => {
  it("defaults to account-only with no endpoints (zero egress surface)", () => {
    const c = loadConfig({});
    expect(c.enabledModes).toEqual(["account"]);
    expect(c.endpoints).toEqual({});
  });

  it("enables optional modes and parses endpoint declarations", () => {
    const c = loadConfig({
      CAIRN_ENABLE_MODES: "api, bridge, bogus",
      CAIRN_ENDPOINT_EU: "anthropic|https://eu.example|EU_KEY|claude-opus-4-8",
    });
    expect(c.enabledModes).toEqual(["account", "api", "bridge"]);
    expect(c.endpoints.eu).toEqual({
      provider: "anthropic",
      baseUrl: "https://eu.example",
      apiKeyEnv: "EU_KEY",
      model: "claude-opus-4-8",
    });
  });
});

describe("provider adapters — truncation guard", () => {
  it("anthropic flags stop_reason=max_tokens as truncated", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "partial" }], stop_reason: "max_tokens" })),
    );
    const r = await callAnthropic(
      { provider: "anthropic", baseUrl: "https://a", apiKeyEnv: "K" },
      baseReq,
      fetchFn as unknown as typeof fetch,
      { K: "x" },
    );
    expect(r.truncated).toBe(true);
    expect(r.text).toBe("partial");
  });

  it("openai flags finish_reason=length as truncated", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "cut" }, finish_reason: "length" }] })),
    );
    const r = await callOpenAICompatible(
      { provider: "openai", baseUrl: "https://o", apiKeyEnv: "K" },
      baseReq,
      fetchFn as unknown as typeof fetch,
      { K: "x" },
    );
    expect(r.truncated).toBe(true);
    expect(r.text).toBe("cut");
  });
});

describe("dynamicMaxTokens", () => {
  it("scales with the expected brief but caps at the model max output", () => {
    expect(dynamicMaxTokens(6_000, 128_000)).toBe(9_000); // 6000 * 1.5
    expect(dynamicMaxTokens(200_000, 128_000)).toBe(128_000); // capped
    expect(dynamicMaxTokens(1, 128_000)).toBe(256); // floor
  });
});
