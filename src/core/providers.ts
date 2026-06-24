/**
 * Cairn - provider adapters for the OPTIONAL API/Bridge mode only (ADR-0004, ADR-0006).
 *
 * In the default account mode these are NEVER called: the egress guardrail
 * (`runOptionalCompaction`) refuses any call unless the mode is explicitly enabled AND the
 * named endpoint is configured. Each adapter shapes the per-provider request, applies a
 * truncation guard, and reads its key from env at call time. Re-implemented per the spec.
 */

import type { CairnConfig, CompactionMode, EndpointConfig } from "./config.js";
import type { Env } from "./env.js";

export class EgressNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressNotConfiguredError";
  }
}

export interface ModelCallRequest {
  systemPrompt?: string;
  prompt: string;
  maxTokens: number;
  model: string;
}

export interface ModelCallResult {
  text: string;
  /** True when the provider stopped because it hit the output cap (truncation guard). */
  truncated: boolean;
  finishReason: string;
}

export type FetchFn = typeof fetch;
/** A model call that produces a brief - used for the sampling and bridge seams. */
export type ModelCaller = (req: ModelCallRequest) => Promise<ModelCallResult>;

/** Dynamic max_tokens: enough headroom for the expected brief, capped at the model max. */
export function dynamicMaxTokens(expectedBriefTokens: number, modelMaxOutput: number, safety = 1.5): number {
  return Math.min(modelMaxOutput, Math.max(256, Math.ceil(expectedBriefTokens * safety)));
}

function authKey(ep: EndpointConfig, env: Env): string | undefined {
  return ep.apiKeyEnv ? env[ep.apiKeyEnv] : undefined;
}

export async function callAnthropic(
  ep: EndpointConfig,
  req: ModelCallRequest,
  fetchFn: FetchFn,
  env: Env = process.env,
): Promise<ModelCallResult> {
  const res = await fetchFn(`${ep.baseUrl.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": authKey(ep, env) ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens,
      ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
      messages: [{ role: "user", content: req.prompt }],
    }),
  });
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
  };
  const text = (json.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  const finishReason = json.stop_reason ?? "unknown";
  return { text, truncated: finishReason === "max_tokens", finishReason };
}

export async function callOpenAICompatible(
  ep: EndpointConfig,
  req: ModelCallRequest,
  fetchFn: FetchFn,
  env: Env = process.env,
): Promise<ModelCallResult> {
  const res = await fetchFn(`${ep.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${authKey(ep, env) ?? ""}`,
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens,
      messages: [
        ...(req.systemPrompt ? [{ role: "system", content: req.systemPrompt }] : []),
        { role: "user", content: req.prompt },
      ],
    }),
  });
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };
  const choice = json.choices?.[0];
  const finishReason = choice?.finish_reason ?? "unknown";
  return { text: choice?.message?.content ?? "", truncated: finishReason === "length", finishReason };
}

export async function callGemini(
  ep: EndpointConfig,
  req: ModelCallRequest,
  fetchFn: FetchFn,
  env: Env = process.env,
): Promise<ModelCallResult> {
  // Security (audit finding 8a): pass the key in a header, not the URL query string (URLs are
  // commonly logged by proxies/servers).
  const url = `${ep.baseUrl.replace(/\/$/, "")}/v1beta/models/${req.model}:generateContent`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": authKey(ep, env) ?? "" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: req.prompt }] }],
      ...(req.systemPrompt ? { systemInstruction: { parts: [{ text: req.systemPrompt }] } } : {}),
      generationConfig: { maxOutputTokens: req.maxTokens },
    }),
  });
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  };
  const cand = json.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  const finishReason = cand?.finishReason ?? "unknown";
  return { text, truncated: finishReason === "MAX_TOKENS", finishReason };
}

const ADAPTERS: Record<EndpointConfig["provider"], (
  ep: EndpointConfig,
  req: ModelCallRequest,
  fetchFn: FetchFn,
  env: Env,
) => Promise<ModelCallResult>> = {
  anthropic: callAnthropic,
  openai: callOpenAICompatible,
  gemini: callGemini,
};

export interface OptionalCompactionInput {
  mode: CompactionMode;
  config: CairnConfig;
  request: ModelCallRequest;
  /** Endpoint name for `api` mode. */
  endpointKey?: string;
  fetchFn?: FetchFn;
  /** Client-sampling caller for `sampling` mode (runs on the user account). */
  sample?: ModelCaller;
  /** Sibling-CLI caller for `bridge` mode (runs on the other CLI's subscription). */
  bridge?: ModelCaller;
  env?: Env;
}

/**
 * THE egress guardrail. Refuses any model call unless the requested mode is NOT "account"
 * (account mode never egresses), the mode is explicitly enabled in config, AND the mode's
 * prerequisite is present (sampler / bridge CLI / configured endpoint). Any miss throws
 * EgressNotConfiguredError BEFORE any network/CLI/sampling call is made.
 */
export async function runOptionalCompaction(input: OptionalCompactionInput): Promise<ModelCallResult> {
  const { mode, config } = input;
  if (mode === "account") {
    throw new EgressNotConfiguredError("account mode does not egress; no model call is made");
  }
  if (!config.enabledModes.includes(mode)) {
    throw new EgressNotConfiguredError(`mode '${mode}' is not enabled; refusing egress`);
  }

  if (mode === "sampling") {
    if (!input.sample) throw new EgressNotConfiguredError("sampling unavailable (client capability missing)");
    return input.sample(input.request);
  }

  if (mode === "bridge") {
    if (!config.bridgeCli) throw new EgressNotConfiguredError("no bridge CLI configured (CAIRN_BRIDGE)");
    if (!input.bridge) throw new EgressNotConfiguredError("bridge caller unavailable");
    return input.bridge(input.request);
  }

  // mode === "api"
  const ep = input.endpointKey ? config.endpoints[input.endpointKey] : undefined;
  if (!ep) {
    throw new EgressNotConfiguredError(`no endpoint '${input.endpointKey ?? ""}' configured; refusing egress`);
  }
  const fetchFn = input.fetchFn ?? fetch;
  const env = input.env ?? process.env;
  return ADAPTERS[ep.provider](ep, input.request, fetchFn, env);
}
