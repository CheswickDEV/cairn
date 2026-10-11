/**
 * Cairn - Claude Code statusline renderer (ADR-0003 surface).
 *
 * Consumes the statusline JSON Claude Code pipes on stdin (`model.id`, `context_window.*`) and
 * computes the quality zone relative to the ACTIVE window (`min(model_max, surface_cap)` - here
 * the host's `context_window.context_window_size` is the surface cap). Pure; the bin wrapper just
 * does stdin→render→stdout.
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

interface TokenCounts {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

export interface StatuslineInput {
  model?: { id?: string; display_name?: string };
  context_window?: TokenCounts & {
    /** Claude Code: maximum context window of the session (the surface cap). */
    context_window_size?: number;
    /** Claude Code: input + cache-creation + cache-read tokens currently in the window. */
    total_input_tokens?: number;
    /** Claude Code: the same counts per component (null before the first API call and after /compact). */
    current_usage?: TokenCounts | null;
    used_percentage?: number | null;
    /** Legacy shape (also built by the Codex rollout adapter): window + top-level token counts. */
    total_tokens?: number;
  };
  workspace?: { current_dir?: string };
}

/** Input tokens in the window (fresh + cache reads + cache writes); output tokens don't count. */
function inputTokens(c: TokenCounts | null | undefined): number {
  return (c?.input_tokens ?? 0) + (c?.cache_read_input_tokens ?? 0) + (c?.cache_creation_input_tokens ?? 0);
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
  // First usable host window: the documented field, else the legacy one (0 / non-numbers = not reported).
  const hostWindow = [cw.context_window_size, cw.total_tokens].find((n) => typeof n === "number" && Number.isFinite(n) && n > 0);
  const win = activeWindow(profile, { surfaceCap: hostWindow });
  // Prefer explicit input-token counts (incl. cache); fall back to used_percentage of the window.
  const tokenSum = cw.total_input_tokens || inputTokens(cw.current_usage) || inputTokens(cw);
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
