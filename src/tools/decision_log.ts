/**
 * `decision_log` tool (ADR-0001/0002) - readOnly.
 *
 * Reads the persisted decision/evidence store. Default view "current" reconstructs the
 * live state (accepted + open) for a new session start; view "all" returns the full,
 * filterable history (including superseded rows - nothing is ever deleted).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DecisionRow, EvidenceRow, StoreApi } from "../store/types.js";
import { isHandoffHead } from "../core/prompts.js";
import { t, type Lang } from "../i18n/index.js";

export interface DecisionLogInput {
  view?: "current" | "all";
  status?: "proposed" | "accepted" | "superseded";
  since?: string;
  until?: string;
  withEvidence?: boolean;
}

export interface DecisionLogEntry extends DecisionRow {
  evidence?: EvidenceRow[];
}

export interface DecisionLogResult {
  view: "current" | "all";
  count: number;
  decisions: DecisionLogEntry[];
}

export function buildDecisionLog(input: DecisionLogInput, store: StoreApi): DecisionLogResult {
  const view = input.view ?? "current";
  const base: DecisionRow[] =
    view === "current"
      ? store.currentState()
      : store.queryDecisions({ status: input.status, since: input.since, until: input.until });

  // Evidence is only attached in the forensic `all` view. The `current` view is the session-start
  // reconstruction and must stay lean - bulk-attaching every decision's evidence there is what blows
  // up the re-injection (it can cost more context than the compaction saved). Evidence is never lost:
  // `view:"all"` (optionally with a `status` filter) still returns it byte-exact.
  const attachEvidence = input.withEvidence === true && view === "all";
  const decisions: DecisionLogEntry[] = base.map((d) =>
    attachEvidence ? { ...d, evidence: store.getEvidence(d.decisionId) } : { ...d },
  );
  return { view, count: decisions.length, decisions };
}

const DecisionShape = z.object({
  decisionId: z.string(),
  ts: z.string(),
  who: z.string(),
  decision: z.string(),
  rationale: z.string(),
  alternatives: z.array(z.string()),
  status: z.enum(["proposed", "accepted", "superseded"]),
  supersedes: z.string().nullable(),
  supersededBy: z.string().nullable(),
  evidence: z
    .array(
      z.object({
        evidenceId: z.string(),
        decisionId: z.string(),
        claim: z.string(),
        sourceRef: z.string(),
        type: z.enum(["msg", "file", "url", "tool_out"]),
        verbatim: z.string().nullable(),
        ts: z.string(),
      }),
    )
    .optional(),
});

export function registerDecisionLog(server: McpServer, store: StoreApi, lang: Lang = "en"): void {
  server.registerTool(
    "decision_log",
    {
      title: "Decision log",
      description:
        "Reads the decision/evidence ledger. view='current' reconstructs accepted+open decisions " +
        "for a new session (lean — evidence is NOT attached here, to keep re-injection small); " +
        "view='all' returns the filterable history including superseded rows, and is the only view " +
        "where withEvidence attaches each decision's evidence.",
      inputSchema: {
        view: z.enum(["current", "all"]).optional(),
        status: z.enum(["proposed", "accepted", "superseded"]).optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        withEvidence: z.boolean().optional(),
      },
      outputSchema: {
        view: z.enum(["current", "all"]),
        count: z.number(),
        decisions: z.array(DecisionShape),
      },
      annotations: { title: "Decision log", readOnlyHint: true },
    },
    async (args) => {
      const r = buildDecisionLog(args, store);
      const m = t(lang).decisionLog;
      const headTitle = t(lang).sessionStart.handoffTitle;
      const text =
        `${m.header({ count: r.count, view: r.view })}\n` +
        r.decisions
          .map((d) => {
            const label = isHandoffHead(d.decision) ? headTitle : d.decision;
            return `• [${d.status}] ${label}${d.supersededBy ? m.supersededBy({ id: d.supersededBy }) : ""}`;
          })
          .join("\n");
      return { content: [{ type: "text", text: text.trim() || m.empty }], structuredContent: { ...r } };
    },
  );
}
