/**
 * `handoff` tool (ADR-0002/0004/0006).
 *
 * DEFAULT = account mode: takes a host-produced 7-bucket brief, runs the deterministic
 * freezeVerbatim masking + validation, picks the summarizer via selectSummarizer, and PERSISTS to
 * the store. The server makes NO model call and there is NO egress in account mode.
 * Optional modes (sampling/bridge/api) only run when explicitly configured; otherwise the egress
 * guardrail refuses the call. In every mode the session model writes the brief (an API endpoint's
 * configured model wins), and the selection becomes a recommendation when it names another model
 * (ADR-0012).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  selectSummarizer,
  resolveProfile,
  normalizeModelId,
  isSameModel,
  summarizerPool,
  detectEcosystem,
  FIDELITY_FLOOR,
  type HostSignal,
  type ReachabilityProbe,
  type SelectResult,
  type Zone,
} from "../core/model-profiles.js";
import { freezeVerbatim, restoreVerbatim, missingVerbatim } from "../core/verbatim.js";
import { runOptionalCompaction, dynamicMaxTokens, type FetchFn, type ModelCaller } from "../core/providers.js";
import { HANDOFF_DECISION_KEY, LEGACY_HANDOFF_TITLE_DE } from "../core/prompts.js";
import { t, type Lang } from "../i18n/index.js";
import type { CairnConfig, CompactionMode } from "../core/config.js";
import type { DecisionStatus, EvidenceType, StoreApi } from "../store/types.js";

export interface HandoffDecisionInput {
  decisionId?: string;
  decision: string;
  rationale: string;
  alternatives?: string[];
  status?: DecisionStatus;
  supersedes?: string;
}

export interface HandoffEvidenceInput {
  claim: string;
  sourceRef: string;
  type: EvidenceType;
  verbatim?: string;
}

export interface HandoffInput {
  /** Account mode: the host-produced 7-bucket brief. Non-account modes: optional, see `source`. */
  brief: string;
  /** Non-account modes: the raw context Cairn compacts itself (falls back to `brief` if absent). */
  source?: string;
  host?: HostSignal;
  /** Optional metadata: explicit saves do not require a status query first. */
  sourceZone?: Zone;
  mode?: CompactionMode;
  who?: string;
  fidelityFloor?: number;
  /** Literal values/IDs to protect byte-exact when freezing the brief. */
  exactSpans?: string[];
  /** Spans that MUST survive byte-exact in the brief; reported if missing. */
  requiredVerbatim?: string[];
  decisions?: HandoffDecisionInput[];
  evidence?: HandoffEvidenceInput[];
  expectedBriefTokens?: number;
  estInputTokens?: number;
  /** Endpoint name for the optional API/bridge mode. */
  endpointKey?: string;
}

export interface HandoffDeps {
  store: StoreApi;
  config: CairnConfig;
  fetchFn?: FetchFn;
  /** sampling-mode caller (client runs completion on the user account). */
  sample?: ModelCaller;
  /** bridge-mode caller (sibling CLI compacts on its subscription). */
  bridge?: ModelCaller;
  select?: typeof selectSummarizer;
  reachable?: ReachabilityProbe;
  /** Language for the human-facing result text + (non-account) compaction prompt. Default 'en'. */
  lang?: Lang;
}

export interface HandoffResult {
  mode: CompactionMode;
  selectionKind: SelectResult["kind"];
  modelId?: string;
  reason: string;
  /** Model that compacted in an optional mode: the one(s) the caller reports as answering, else the requested
   *  one (the session model, or the endpoint's); absent = unknown (the CLI's default, an unreporting
   *  sampling client). Also the brief's `who` in the ledger. */
  compactedWith?: string;
  /** Every mode: the selected summarizer when the model that wrote the brief (the host's in account mode, else
   *  `compactedWith`) is another one or unknown, unless the model asked for already is it (a fallback answered)
   *  or the API endpoint's provider has no pool (gemini) (ADR-0012). */
  recommendedModel?: string;
  storedDecisionId: string;
  verbatimHolds: number;
  missingRequired: string[];
  decisionsStored: number;
  evidenceStored: number;
  egress: boolean;
}

/**
 * Effort for a model-driven compaction (ADR-0012): `high` for an id that resolves to a summarizer-pool
 * profile (all seven support it) - including the decorated or prefixed ids `resolveProfile` maps to
 * one, such as `[1m]`, a Bedrock prefix, a snapshot date or `-codex`. A suspended, context-only or
 * unrecognised model keeps its provider default, since it may reject the parameter. Only the API
 * adapters read it; the bridge always runs at `high`, sampling cannot set it.
 */
export function compactionEffort(modelId: string | undefined): string | undefined {
  const p = resolveProfile(modelId);
  return summarizerPool().includes(p) ? "high" : undefined;
}

/** Output budget at effort `high` in API mode. Anthropic: `max_tokens` is a hard limit on thinking plus the
 *  answer, so set it large at `high`; OpenAI advises reserving at least 25,000 tokens for reasoning and
 *  output. Limit: the adapters do not stream, so a very long generation can hit fetch's ~300 s header
 *  timeout (ADR-0012). */
export const EFFORT_MAX_TOKENS = 32_000;

/** Ecosystem of the model an optional mode runs (ADR-0012): the bridge CLI's, or an API endpoint's provider.
 *  undefined = no pool there (a gemini endpoint) or the host's own (account, sampling). */
function compactionEcosystem(mode: CompactionMode, config: CairnConfig, endpointKey?: string): "anthropic" | "openai" | undefined {
  if (mode === "bridge") return config.bridgeCli === "claude" ? "anthropic" : config.bridgeCli === "codex" ? "openai" : undefined;
  if (mode === "api") {
    const provider = endpointKey ? config.endpoints[endpointKey]?.provider : undefined;
    return provider === "anthropic" || provider === "openai" ? provider : undefined;
  }
  return undefined;
}

/** The endpoint an API-mode handoff uses: the one named, else the first configured. */
function endpointKeyFor(input: HandoffInput, config: CairnConfig): string | undefined {
  return input.endpointKey ?? Object.keys(config.endpoints)[0];
}

/** Where the model that writes the brief comes from (ADR-0012): the session (account mode, sampling, and
 *  bridge/API with a host model of their ecosystem), an API endpoint's configured model, or the bridge CLI's
 *  own default. */
export type ModelSource = "session" | "endpoint" | "cli";

/**
 * The model an optional mode asks for (ADR-0012): the session model writes the brief in every mode (user
 * decision, 2026-10-12). An API endpoint's configured model wins: a gateway or an Azure deployment names its
 * own models. Otherwise the host's model where it runs: in sampling as a hint (the client decides), in
 * bridge/API only when it belongs to the bridge CLI's or the endpoint's ecosystem (judged by the id when it
 * names one, so a contradicting provider does not send a GPT id to claude). Else none: the bridge CLI's
 * default; API refuses the call before egress. An endpoint outside the pool (gemini) without a model: the
 * host's, as before. API mode drops Claude Code's context suffix (`claude-opus-5-5[1m]`): it is no part of
 * a provider's model id.
 */
export function compactionPlan(
  mode: CompactionMode,
  host: HostSignal,
  config: CairnConfig,
  endpointKey: string | undefined,
): { model?: string; source: ModelSource } {
  const endpointModel = mode === "api" && endpointKey ? config.endpoints[endpointKey]?.model : undefined;
  if (endpointModel) return { model: endpointModel, source: "endpoint" };
  const target = compactionEcosystem(mode, config, endpointKey);
  const byId = detectEcosystem({ modelId: host.modelId });
  const sessionEcosystem = byId === "generic" ? detectEcosystem(host) : byId;
  const model = mode === "api" ? host.modelId?.replace(/\[[A-Za-z0-9]+\]$/, "") : host.modelId;
  if (!target || (host.modelId && sessionEcosystem === target)) return { model, source: "session" };
  return { source: mode === "bridge" ? "cli" : "session" };
}

/** The model a compaction can be credited to: the one(s) the caller reports as answering (claude's
 *  `modelUsage`, a codex reroute, the sampling client's `model`) when they differ from the request or
 *  nothing was requested; else the requested one. Sampling reports nothing else: its request is a hint. */
function creditedModel(mode: CompactionMode, requested: string | undefined, answered: string[] | undefined): string | undefined {
  if (answered?.length && !(requested && answered.every((m) => isSameModel(m, normalizeModelId(requested))))) return answered.join(", ");
  return mode === "sampling" && !answered?.length ? undefined : requested;
}

export async function runHandoff(input: HandoffInput, deps: HandoffDeps): Promise<HandoffResult> {
  const mode: CompactionMode = input.mode ?? "account";
  const host = input.host ?? {};
  const lang: Lang = deps.lang ?? "en";
  const select = deps.select ?? selectSummarizer;
  // The text a model would compact: the host brief in account mode, the raw source in the model-driven modes.
  const sourceText = mode === "account" ? input.brief : input.source ?? input.brief;
  const endpointKey = endpointKeyFor(input, deps.config);
  // Bridge/API recommend in the ecosystem they run in, so a Codex host with a claude bridge gets a Claude model.
  const target = compactionEcosystem(mode, deps.config, endpointKey);
  const plan = compactionPlan(mode, host, deps.config, endpointKey);

  // Quality-first selection. The session model writes the brief, so in every mode the selection is a
  // recommendation, made in the ecosystem the brief is written in (ADR-0012).
  const selection = await select({
    host: target ? { provider: target } : host,
    // Conservative selector input when unknown, not a measured context-zone claim.
    sourceZone: input.sourceZone ?? "red",
    cost: {
      // Tokens, not characters: the long-context tiers (Haiku 5.5 above 100K, GPT-6 above 272K) and the
      // cost tiebreak count tokens. ~4 characters per token, as the calibration estimates (runner.ts).
      inputTokens: input.estInputTokens ?? Math.ceil(sourceText.length / 4),
      expectedBriefTokens: input.expectedBriefTokens ?? 6_000,
    },
    fidelityFloor: input.fidelityFloor ?? FIDELITY_FLOOR,
    reachable: deps.reachable,
  });

  // Deterministic verbatim layer: freeze the text we will compact (the host brief in account
  // mode, or the raw source in the model-driven modes).
  const frozen = freezeVerbatim(sourceText, input.exactSpans ?? []);

  // Produce the effective brief. Account mode = the host already made it (no model call/egress).
  // Optional modes call through the egress guardrail (throws unless explicitly configured).
  let effectiveBrief: string;
  let egress = false;
  let compactedWith: string | undefined;
  if (mode === "account") {
    effectiveBrief = input.brief;
  } else {
    // Effort + its larger budget only where they reach the provider: the API adapters. The bridge pins
    // `high` itself, and sampling cannot carry an effort (ADR-0012).
    const model = plan.model;
    // A pool model's effort only goes to its own provider: not to a gemini endpoint, and not to a model of the
    // other ecosystem behind an endpoint (an OpenAI-compatible gateway serving Claude).
    const effort = mode === "api" && target && resolveProfile(model).ecosystem === target ? compactionEffort(model) : undefined;
    const briefTokens = dynamicMaxTokens(input.expectedBriefTokens ?? 4_096, 8_192);
    const maxTokens = effort ? Math.max(briefTokens, EFFORT_MAX_TOKENS) : briefTokens;
    const result = await runOptionalCompaction({
      mode,
      config: deps.config,
      request: {
        systemPrompt: t(lang).prompts.sevenBucket,
        prompt: frozen.masked,
        maxTokens,
        model: model ?? "",
        effort,
      },
      endpointKey,
      fetchFn: deps.fetchFn,
      sample: deps.sample,
      bridge: deps.bridge,
    });
    compactedWith = creditedModel(mode, model, result.modelsUsed);
    effectiveBrief = restoreVerbatim(result.text, frozen.holds);
    egress = true;
  }

  const missingRequired = missingVerbatim(effectiveBrief, input.requiredVerbatim ?? []);

  // Persist: the brief as a handoff decision, with verbatim holds bound as byte-exact evidence.
  const who = input.who ?? host.modelId ?? "host";
  // Collapse prior handoff briefs: a new brief SUPERSEDES the previous one(s), so the live state
  // (decision_log view=current / the SessionStart re-injection) carries only the LATEST brief, not
  // every historical one. Without this the briefs accumulate unbounded and re-injection eventually
  // costs more context than the compaction saves. Atomic decisions/evidence below are untouched -
  // only the redundant full-brief heads collapse. (Captured before the append so the new head is
  // excluded.) The rows survive as `superseded` and stay reachable via view=all (append-only).
  const priorBriefs = deps.store
    .currentState()
    .filter((d) => d.decision === HANDOFF_DECISION_KEY || d.decision === LEGACY_HANDOFF_TITLE_DE);
  const head = deps.store.appendDecision({
    // The brief's author: the compacting model in the optional modes, else the host.
    who: compactedWith ?? who,
    decision: HANDOFF_DECISION_KEY,
    rationale: effectiveBrief,
    status: "accepted",
  });
  for (const prior of priorBriefs) deps.store.supersede(prior.decisionId, head.decisionId);

  for (const h of frozen.holds) {
    deps.store.addEvidence({
      decisionId: head.decisionId,
      claim: t(lang).handoff.verbatimClaim,
      sourceRef: host.modelId ?? "brief",
      type: "tool_out",
      verbatim: h.content,
    });
  }

  // Persist host-extracted structured decisions/evidence (supersession handled by the store).
  let decisionsStored = 0;
  const lastDecisionId = head.decisionId;
  for (const d of input.decisions ?? []) {
    deps.store.appendDecision({
      decisionId: d.decisionId,
      who,
      decision: d.decision,
      rationale: d.rationale,
      alternatives: d.alternatives,
      status: d.status,
      supersedes: d.supersedes,
    });
    decisionsStored++;
  }

  let evidenceStored = frozen.holds.length;
  for (const e of input.evidence ?? []) {
    deps.store.addEvidence({
      decisionId: lastDecisionId,
      claim: e.claim,
      sourceRef: e.sourceRef,
      type: e.type,
      verbatim: e.verbatim ?? null,
    });
    evidenceStored++;
  }

  // The brief's writer: the host in account mode, else the model that compacted. If the selection names
  // another model, or the writer is unknown, recommend the selection (ADR-0012). Not when the model asked for
  // already is the selection (a fallback answered: switching would change nothing), and not for an endpoint
  // whose provider has no pool (gemini), where the selection names a model it cannot run.
  const isSelected = (id: string | undefined) =>
    selection.kind === "model" && !!id && resolveProfile(id).id === selection.model.id;
  const writer = mode === "account" ? host.modelId : compactedWith;
  const recommendedModel =
    selection.kind === "model" && !isSelected(writer) && !isSelected(plan.model) && !(mode === "api" && !target)
      ? selection.model.id
      : undefined;

  return {
    mode,
    selectionKind: selection.kind,
    modelId: selection.kind === "model" ? selection.model.id : undefined,
    reason: selection.reason,
    ...(compactedWith ? { compactedWith } : {}),
    ...(recommendedModel ? { recommendedModel } : {}),
    storedDecisionId: head.decisionId,
    verbatimHolds: frozen.holds.length,
    missingRequired,
    decisionsStored,
    evidenceStored,
    egress,
  };
}

/** The tool text's recommendation (ADR-0012): who wrote the brief, the most faithful summarizer, and how to
 *  get it there, by where the writing model came from. "" when the result recommends nothing. */
export function recommendationLine(r: HandoffResult, input: HandoffInput, config: CairnConfig, lang: Lang): string {
  if (!r.recommendedModel) return "";
  const endpoint = endpointKeyFor(input, config);
  return t(lang).handoff.recommend({
    writer: r.mode === "account" ? input.host?.modelId : r.compactedWith,
    model: resolveProfile(r.recommendedModel).displayName,
    source: compactionPlan(r.mode, input.host ?? {}, config, endpoint).source,
    cli: config.bridgeCli,
    endpoint,
  });
}

export function registerHandoff(server: McpServer, deps: HandoffDeps): void {
  server.registerTool(
    "handoff",
    {
      title: "Handoff",
      description:
        "Use only for an explicit user request to save a Cairn handoff. " +
        "Persists a host-produced 7-bucket brief: freezes verbatim spans, validates required " +
        "verbatim, records decisions/evidence. Default account mode makes NO model call / NO egress.",
      inputSchema: {
        brief: z.string(),
        source: z.string().optional(),
        host: z.object({ modelId: z.string().optional(), provider: z.string().optional() }).optional(),
        sourceZone: z.enum(["green", "yellow", "red"]).optional(),
        mode: z.enum(["account", "sampling", "bridge", "api"]).optional(),
        who: z.string().optional(),
        fidelityFloor: z.number().min(0).max(1).optional(),
        exactSpans: z.array(z.string()).optional(),
        requiredVerbatim: z.array(z.string()).optional(),
        decisions: z
          .array(
            z.object({
              decisionId: z.string().optional(),
              decision: z.string(),
              rationale: z.string(),
              alternatives: z.array(z.string()).optional(),
              status: z.enum(["proposed", "accepted", "superseded"]).optional(),
              supersedes: z.string().optional(),
            }),
          )
          .optional(),
        evidence: z
          .array(
            z.object({
              claim: z.string(),
              sourceRef: z.string(),
              type: z.enum(["msg", "file", "url", "tool_out"]),
              verbatim: z.string().optional(),
            }),
          )
          .optional(),
        expectedBriefTokens: z.number().int().positive().optional(),
        estInputTokens: z.number().int().nonnegative().optional(),
        endpointKey: z.string().optional(),
      },
      outputSchema: {
        mode: z.enum(["account", "sampling", "bridge", "api"]),
        selectionKind: z.enum(["model", "verbatim-fallback"]),
        modelId: z.string().optional(),
        reason: z.string(),
        compactedWith: z.string().optional(),
        recommendedModel: z.string().optional(),
        storedDecisionId: z.string(),
        verbatimHolds: z.number(),
        missingRequired: z.array(z.string()),
        decisionsStored: z.number(),
        evidenceStored: z.number(),
        egress: z.boolean(),
      },
      annotations: { title: "Handoff", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const r = await runHandoff(args as HandoffInput, deps);
      const m = t(deps.lang ?? "en").handoff;
      const selection =
        r.selectionKind === "model"
          ? m.selModel({ model: r.modelId, reason: r.reason })
          : m.selVerbatim({ reason: r.reason });
      const warn =
        (r.missingRequired.length ? `\n${m.missingVerbatim({ spans: r.missingRequired.join(", ") })}` : "") +
        // The recommendation names the writer itself.
        (r.compactedWith && !r.recommendedModel ? `\n${m.compactedWith({ model: r.compactedWith })}` : "") +
        (r.recommendedModel ? `\n${recommendationLine(r, args as HandoffInput, deps.config, deps.lang ?? "en")}` : "");
      const text = m.result({
        mode: r.mode,
        egress: r.egress,
        selection,
        holds: r.verbatimHolds,
        decisions: r.decisionsStored,
        evidence: r.evidenceStored,
        id: r.storedDecisionId,
        warn,
      });
      return { content: [{ type: "text", text }], structuredContent: { ...r } };
    },
  );
}
