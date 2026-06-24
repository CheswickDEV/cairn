/**
 * Cairn - Claude Code statusline renderer (ADR-0003 surface).
 *
 * Consumes the statusline JSON Claude Code pipes on stdin (`model.id`, `context_window.*`) and
 * computes the quality zone relative to the ACTIVE window (`min(model_max, surface_cap)` - here
 * the host's `context_window.total_tokens` is the surface cap). Pure; the bin wrapper just does
 * stdin→render→stdout.
 */

import {
  PROFILES,
  resolveProfile,
  activeWindow,
  zoneBoundaries,
  classifyZone,
  type ModelProfile,
  type Zone,
} from "../core/model-profiles.js";
import { t, type Lang } from "../i18n/index.js";

export interface StatuslineInput {
  model?: { id?: string; display_name?: string };
  context_window?: {
    used_percentage?: number;
    total_tokens?: number;
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
  };
  workspace?: { current_dir?: string };
}

export interface StatusComputation {
  modelId: string;
  zone: Zone;
  window: number;
  usedTokens: number;
  usedPct: number;
}

export function computeStatus(input: StatuslineInput, profiles: ModelProfile[] = PROFILES): StatusComputation {
  const profile = resolveProfile(input.model?.id, profiles);
  const cw = input.context_window ?? {};
  // Surface cap = the host-reported window (e.g. 200k in Claude Code); ADR-0003.
  const win = activeWindow(profile, { surfaceCap: cw.total_tokens });
  // Prefer explicit input-token counts (incl. cache); fall back to used_percentage of the window.
  const tokenSum =
    (cw.input_tokens ?? 0) + (cw.cache_read_input_tokens ?? 0) + (cw.cache_creation_input_tokens ?? 0);
  const usedTokens =
    tokenSum > 0 ? tokenSum : cw.used_percentage != null ? Math.round((cw.used_percentage / 100) * win) : 0;
  const b = zoneBoundaries(profile, win);
  return {
    modelId: profile.id,
    zone: classifyZone(usedTokens, b),
    window: win,
    usedTokens,
    usedPct: win > 0 ? usedTokens / win : 0,
  };
}

const DOT: Record<Zone, string> = { green: "🟢", yellow: "🟡", red: "🔴" };

/** One-line statusline string (emoji + % + model + localized zone hint). */
export function renderStatusline(
  input: StatuslineInput,
  lang: Lang = "en",
  profiles: ModelProfile[] = PROFILES,
): string {
  const s = computeStatus(input, profiles);
  const name = input.model?.display_name ?? s.modelId;
  const hint = t(lang).statusline.hint[s.zone];
  return `${DOT[s.zone]} ${(s.usedPct * 100).toFixed(0)}% ctx · ${name}${hint}`;
}
