/**
 * Cairn - context-window reachability for calibration candidates (ADR-0003/0004).
 *
 * A model can only compact a probe if the probe FITS its active window. Two empirical facts from
 * the 2026-06-22 bridge runs drive this:
 *  1. `claude -p` / `codex exec` inflate a probe into the request by ~1.7× (the piped input is
 *     counted as conversation AND attachment, plus a base system/tool overhead). An 800k-token
 *     probe became a ~1.33M-token request → rejected; a 400k probe (~0.68M request) was accepted.
 *  2. The effective window is SURFACE-dependent (ADR-0003) and NOT the profile's API maximum: via
 *     the subscription CLI, opus took 400k but sonnet & haiku rejected it → their effective window
 *     is ≈ 200k, not the 1M the API tier allows. Codex windows are tracked separately below.
 *  The current Claude generation runs a native 1M window in Claude Code (documented, not yet
 *  bridge-measured). For GPT-6 via Codex the window Codex applies was read from real runs (ADR-0012 stage
 *  4b', 2026-10-11): the rollout's `model_context_window` is 258400 for all three, Codex's usable share
 *  (95 %) of the catalog's 272000 in codex 0.162.1 - a client-side value, not a server load test. Codex
 *  compacts on its own from 244800 (90 %) mid-turn whenever it continues a turn (after a tool call, an
 *  incomplete response or end_turn: false); a fresh call starts below every threshold.
 *
 * So we pre-filter candidates whose effective window can't hold the probe - instead of wasting a
 * call that returns "Prompt is too long".
 */

import type { ModelProfile } from "../core/model-profiles.js";

/** request_tokens ≈ probe_tokens × this (attachment + conversation + base overhead). */
export const REQUEST_INFLATION = 1.7;

/**
 * Effective SUBSCRIPTION-CLI windows, distinct from the profiles' API maxima. GPT-6 via Codex is the
 * window Codex reports (4b'); the Claude 5.x values follow Claude Code's documented default, not measured.
 */
export const BRIDGE_WINDOWS: Record<string, number> = {
  // Not yet bridge-measured: Claude Code runs Fable 5.1, Sonnet 5.5, Haiku 5.5 and Opus 4.7 and later with
  // their native 1M window by default (as Opus 4.8 measured).
  "claude-fable-5-1": 1_000_000,
  "claude-opus-5-5": 1_000_000,
  "claude-sonnet-5-5": 1_000_000,
  "claude-haiku-5-5": 1_000_000,
  // GPT-6 via Codex: as Codex reports it (ADR-0012 4b', 2026-10-11): 95 % of the catalog's 272000 in 0.162.1.
  "gpt-6-astra": 258_400,
  "gpt-6.1-sol": 258_400,
  "gpt-6-luna": 258_400,
  // Earlier generation (suspended, ADR-0012) - measured/estimated values kept:
  "claude-opus-4-8": 1_000_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-fable-5": 1_000_000,
  // Bridge calibration estimate; product status uses the host-reported model_context_window.
  "gpt-5.5": 400_000,
  "gpt-5.5-pro": 400_000,
  "gpt-5.4": 400_000,
  "gpt-5.4-pro": 400_000,
};

export function bridgeWindow(modelId: string, profile?: ModelProfile): number {
  return BRIDGE_WINDOWS[modelId] ?? profile?.context.window ?? 200_000;
}

/** Estimated total request size for a probe of `probeTokens`. */
export function estimateRequestTokens(probeTokens: number): number {
  return Math.round(probeTokens * REQUEST_INFLATION);
}

/** True if a probe of `probeTokens` fits the model's effective bridge window. */
export function probeFitsModel(modelId: string, probeTokens: number, profile?: ModelProfile): boolean {
  return estimateRequestTokens(probeTokens) <= bridgeWindow(modelId, profile);
}

export interface FitPartition {
  fit: string[]; // variant ids that fit
  excluded: { id: string; window: number; request: number }[];
}

/** Split candidate variant ids into those whose base model fits the probe and those that don't. */
export function partitionByWindow(
  candidates: string[],
  probeTokens: number,
  profiles: ModelProfile[],
  baseOf: (variantId: string) => string,
): FitPartition {
  const request = estimateRequestTokens(probeTokens);
  const fit: string[] = [];
  const excluded: FitPartition["excluded"] = [];
  for (const id of candidates) {
    const base = baseOf(id);
    const profile = profiles.find((p) => p.id === base);
    const window = bridgeWindow(base, profile);
    if (request <= window) fit.push(id);
    else excluded.push({ id, window, request });
  }
  return { fit, excluded };
}
