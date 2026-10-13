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
import { normalizeModelId } from "./model-profiles.js";

export class EgressNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressNotConfiguredError";
  }
}

/** A compaction call that failed or returned no text (ADR-0012): the handoff stores nothing and the previous
 *  brief stays current. */
export class CompactionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionFailedError";
  }
}

export interface ModelCallRequest {
  systemPrompt?: string;
  prompt: string;
  maxTokens: number;
  model: string;
  /** Reasoning effort for the API adapters (ADR-0012): Anthropic `output_config.effort`, OpenAI
   *  `reasoning_effort`. Unset = provider default. Sampling cannot carry it; the bridge sets its own. */
  effort?: string;
}

export interface ModelCallResult {
  text: string;
  /** True when the provider stopped because it hit the output cap (truncation guard). */
  truncated: boolean;
  finishReason: string;
  /** The model ids that produced output, when the caller reports them: claude `modelUsage`, a codex reroute,
   *  the sampling client's `model`. */
  modelsUsed?: string[];
  /** Bridge (claude): every model id `modelUsage` lists, with or without output. */
  modelsReported?: string[];
  /** Bridge (claude): the output was neither a JSON object nor a JSON array; the error result's `text` is the
   *  raw output, not an error message the CLI reported. */
  unparsed?: boolean;
  /** API: the provider stopped the answer short of a regular end or the output cap (Anthropic `refusal`,
   *  OpenAI `content_filter` or a `message.refusal`, a Gemini finish reason other than `STOP`, `MAX_TOKENS`
   *  and the unused `FINISH_REASON_UNSPECIFIED`, a non-empty Gemini `promptFeedback.blockReason`); any text
   *  is no brief (ADR-0012). */
  blocked?: boolean;
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

/** Refuse an HTTP error (ADR-0012) with the provider's own message (`error.message` in the Anthropic, OpenAI
 *  and Gemini error bodies), instead of reading the error body as an empty brief. */
async function assertOk(res: Response, provider: EndpointConfig["provider"]): Promise<void> {
  if (res.ok) return;
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: unknown } | string } | null;
    const e = body?.error;
    detail = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : "";
  } catch {
    // not JSON (a gateway's HTML error page)
  }
  throw new CompactionFailedError(`${provider} API returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
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
      ...(req.effort ? { output_config: { effort: req.effort } } : {}),
    }),
  });
  await assertOk(res, "anthropic");
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
  };
  const text = (json.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  const finishReason = json.stop_reason ?? "unknown";
  return { text, truncated: finishReason === "max_tokens", finishReason, ...(finishReason === "refusal" ? { blocked: true } : {}) };
}

/** The output cap field for Chat Completions (ADR-0012). Ids in OpenAI's naming (`gpt-<digit>…`, `o<digit>…`, also
 *  as a fine-tune `ft:<base>:…`; read after `normalizeModelId`: any case, a provider prefix like `openai/`, a `[…]`
 *  or `@…` suffix) get `max_completion_tokens`, which bounds visible output plus reasoning tokens; OpenAI documents
 *  `max_tokens` as deprecated and incompatible with o-series models. Any other id keeps `max_tokens`, the field
 *  OpenAI-compatible servers read: other models (Ollama, vLLM, a gateway serving Claude, open-weight `gpt-oss`,
 *  `gpt2` or `gpt-j`) and an endpoint model named otherwise (an Azure deployment name). */
export function openAITokenField(model: string): "max_completion_tokens" | "max_tokens" {
  return /^(?:ft:)?(?:gpt-\d|o\d)/.test(normalizeModelId(model)) ? "max_completion_tokens" : "max_tokens";
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
      [openAITokenField(req.model)]: req.maxTokens,
      messages: [
        ...(req.systemPrompt ? [{ role: "system", content: req.systemPrompt }] : []),
        { role: "user", content: req.prompt },
      ],
      ...(req.effort ? { reasoning_effort: req.effort } : {}), // Chat Completions spelling (Responses: reasoning.effort)
    }),
  });
  await assertOk(res, "openai");
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>;
  };
  const choice = json.choices?.[0];
  // A model refusal comes in `message.refusal`, not in `content`; its text is reported instead of any content.
  const refusal = choice?.message?.refusal;
  const refused = typeof refusal === "string" && refusal.trim() !== "";
  const finishReason = refused ? "refusal" : choice?.finish_reason ?? "unknown";
  return {
    text: refused ? refusal : choice?.message?.content ?? "",
    truncated: finishReason === "length",
    finishReason,
    ...(refused || finishReason === "content_filter" ? { blocked: true } : {}),
  };
}

/** Gemini finish reasons of a regular answer (`FINISH_REASON_UNSPECIFIED` is documented as unused). */
const GEMINI_NORMAL_FINISH = new Set(["STOP", "MAX_TOKENS", "FINISH_REASON_UNSPECIFIED"]);

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
  await assertOk(res, "gemini");
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    promptFeedback?: { blockReason?: string } | null;
  };
  const cand = json.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  // A blocked prompt gets no candidates, only a `promptFeedback.blockReason` (`BLOCK_REASON_UNSPECIFIED` is
  // documented as unused).
  const promptBlock = json.promptFeedback?.blockReason;
  if (typeof promptBlock === "string" && promptBlock.trim() !== "" && promptBlock !== "BLOCK_REASON_UNSPECIFIED") {
    return { text, truncated: false, finishReason: `prompt blocked: ${promptBlock}`, blocked: true };
  }
  const finishReason = cand?.finishReason ?? "unknown";
  // Every other Gemini finish reason stops the answer short: SAFETY, RECITATION, BLOCKLIST, PROHIBITED_CONTENT …
  // An absent (or null) one means the model has not stopped: no verdict.
  const blocked = cand?.finishReason != null && !GEMINI_NORMAL_FINISH.has(finishReason);
  return { text, truncated: finishReason === "MAX_TOKENS", finishReason, ...(blocked ? { blocked: true } : {}) };
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
 * prerequisite is present (sampler / bridge CLI / configured endpoint with a model id). Any miss throws
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
  // Every API needs a model id: refuse instead of sending an empty one (ADR-0012).
  if (!input.request.model) {
    throw new EgressNotConfiguredError(
      `no model for endpoint '${input.endpointKey}': set its model (CAIRN_ENDPOINT_<NAME>=provider|baseUrl|apiKeyEnv|model); refusing egress`,
    );
  }
  const fetchFn = input.fetchFn ?? fetch;
  const env = input.env ?? process.env;
  return ADAPTERS[ep.provider](ep, input.request, fetchFn, env);
}
