/**
 * `handoff` tool (ADR-0002/0004/0006).
 *
 * DEFAULT = account mode: takes a host-produced 7-bucket brief, runs the deterministic
 * freezeVerbatim masking + validation, picks the (informational) summarizer via
 * selectSummarizer, and PERSISTS to the store. The server makes NO model call and there is
 * NO egress in account mode. Optional modes (sampling/bridge/api) only run when explicitly
 * configured; otherwise the egress guardrail refuses the call.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  selectSummarizer,
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
  host: HostSignal;
  sourceZone: Zone;
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
  storedDecisionId: string;
  verbatimHolds: number;
  missingRequired: string[];
  decisionsStored: number;
  evidenceStored: number;
  egress: boolean;
}

export async function runHandoff(input: HandoffInput, deps: HandoffDeps): Promise<HandoffResult> {
  const mode: CompactionMode = input.mode ?? "account";
  const lang: Lang = deps.lang ?? "en";
  const select = deps.select ?? selectSummarizer;

  // Quality-first selection (informational in account mode; provider choice in API mode).
  const selection = await select({
    host: input.host,
    sourceZone: input.sourceZone,
    cost: {
      inputTokens: input.estInputTokens ?? input.brief.length,
      expectedBriefTokens: input.expectedBriefTokens ?? 6_000,
    },
    fidelityFloor: input.fidelityFloor ?? FIDELITY_FLOOR,
    reachable: deps.reachable,
  });

  // Deterministic verbatim layer: freeze the text we will compact (the host brief in account
  // mode, or the raw source in the model-driven modes).
  const sourceText = mode === "account" ? input.brief : input.source ?? input.brief;
  const frozen = freezeVerbatim(sourceText, input.exactSpans ?? []);

  // Produce the effective brief. Account mode = the host already made it (no model call/egress).
  // Optional modes call through the egress guardrail (throws unless explicitly configured).
  let effectiveBrief: string;
  let egress = false;
  if (mode === "account") {
    effectiveBrief = input.brief;
  } else {
    const maxTokens = dynamicMaxTokens(input.expectedBriefTokens ?? 4_096, 8_192);
    const result = await runOptionalCompaction({
      mode,
      config: deps.config,
      request: {
        systemPrompt: t(lang).prompts.sevenBucket,
        prompt: frozen.masked,
        maxTokens,
        model: input.host.modelId ?? "",
      },
      endpointKey: input.endpointKey ?? Object.keys(deps.config.endpoints)[0],
      fetchFn: deps.fetchFn,
      sample: deps.sample,
      bridge: deps.bridge,
    });
    effectiveBrief = restoreVerbatim(result.text, frozen.holds);
    egress = true;
  }

  const missingRequired = missingVerbatim(effectiveBrief, input.requiredVerbatim ?? []);

  // Persist: the brief as a handoff decision, with verbatim holds bound as byte-exact evidence.
  const who = input.who ?? input.host.modelId ?? "host";
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
    who,
    decision: HANDOFF_DECISION_KEY,
    rationale: effectiveBrief,
    status: "accepted",
  });
  for (const prior of priorBriefs) deps.store.supersede(prior.decisionId, head.decisionId);

  for (const h of frozen.holds) {
    deps.store.addEvidence({
      decisionId: head.decisionId,
      claim: t(lang).handoff.verbatimClaim,
      sourceRef: input.host.modelId ?? "brief",
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

  return {
    mode,
    selectionKind: selection.kind,
    modelId: selection.kind === "model" ? selection.model.id : undefined,
    reason: selection.reason,
    storedDecisionId: head.decisionId,
    verbatimHolds: frozen.holds.length,
    missingRequired,
    decisionsStored,
    evidenceStored,
    egress,
  };
}

export function registerHandoff(server: McpServer, deps: HandoffDeps): void {
  server.registerTool(
    "handoff",
    {
      title: "Handoff",
      description:
        "Persists a host-produced 7-bucket brief: freezes verbatim spans, validates required " +
        "verbatim, records decisions/evidence. Default account mode makes NO model call / NO egress.",
      inputSchema: {
        brief: z.string(),
        source: z.string().optional(),
        host: z.object({ modelId: z.string().optional(), provider: z.string().optional() }),
        sourceZone: z.enum(["green", "yellow", "red"]),
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
      const warn = r.missingRequired.length ? `\n${m.missingVerbatim({ spans: r.missingRequired.join(", ") })}` : "";
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
