/**
 * `context_status` tool (ADR-0003) - readOnly.
 *
 * Zones are computed as a fraction of the ACTIVE window `min(model_max, surface_cap,
 * user_override)`, never the model maximum. A usecase `noiseFactor` (<=1) tightens the
 * boundaries for tool-/search-heavy sessions.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  PROFILES,
  resolveProfile,
  activeWindow,
  zoneBoundaries,
  classifyZone,
  type ModelProfile,
  type Zone,
  type HostSignal,
} from "../core/model-profiles.js";
import { t, type Lang } from "../i18n/index.js";

export interface ContextStatusInput {
  host: HostSignal;
  usedTokens: number;
  surfaceCap?: number;
  userOverride?: number;
  noiseFactor?: number;
}

export interface ContextStatusResult {
  modelId: string;
  zone: Zone;
  window: number;
  greenUntil: number;
  yellowUntil: number;
  redUntil: number;
  usedTokens: number;
  usedPct: number;
  recommendation: string;
}

export function buildContextStatus(
  input: ContextStatusInput,
  lang: Lang = "en",
  profiles: ModelProfile[] = PROFILES,
): ContextStatusResult {
  const profile = resolveProfile(input.host.modelId, profiles);
  const win = activeWindow(profile, { surfaceCap: input.surfaceCap, userOverride: input.userOverride });
  const b = zoneBoundaries(profile, win, input.noiseFactor ?? 1);
  const zone = classifyZone(input.usedTokens, b);
  return {
    modelId: profile.id,
    zone,
    window: win,
    greenUntil: b.greenUntil,
    yellowUntil: b.yellowUntil,
    redUntil: b.redUntil,
    usedTokens: input.usedTokens,
    usedPct: win > 0 ? input.usedTokens / win : 0,
    recommendation: t(lang).contextStatus.rec[zone],
  };
}

export function registerContextStatus(
  server: McpServer,
  lang: Lang = "en",
  profiles: ModelProfile[] = PROFILES,
): void {
  server.registerTool(
    "context_status",
    {
      title: "Context status",
      description:
        "Reports the quality zone (green/yellow/red) for the current token usage, relative to the " +
        "active surface window (ADR-0003), with a plain-language recommendation.",
      inputSchema: {
        host: z.object({ modelId: z.string().optional(), provider: z.string().optional() }),
        usedTokens: z.number().int().nonnegative(),
        surfaceCap: z.number().int().positive().optional(),
        userOverride: z.number().int().positive().optional(),
        noiseFactor: z.number().min(0).max(1).optional(),
      },
      outputSchema: {
        modelId: z.string(),
        zone: z.enum(["green", "yellow", "red"]),
        window: z.number(),
        greenUntil: z.number(),
        yellowUntil: z.number(),
        redUntil: z.number(),
        usedTokens: z.number(),
        usedPct: z.number(),
        recommendation: z.string(),
      },
      annotations: { title: "Context status", readOnlyHint: true },
    },
    async (args) => {
      const r = buildContextStatus(args, lang, profiles);
      const locale = lang === "de" ? "de-DE" : "en-US";
      const fmt = (n: number): string => n.toLocaleString(locale);
      const text =
        `${r.recommendation}\n` +
        t(lang).contextStatus.body({
          model: r.modelId,
          used: fmt(r.usedTokens),
          window: fmt(r.window),
          pct: (r.usedPct * 100).toFixed(1),
          green: fmt(r.greenUntil),
          yellow: fmt(r.yellowUntil),
          red: fmt(r.redUntil),
        });
      return { content: [{ type: "text", text }], structuredContent: { ...r } };
    },
  );
}
