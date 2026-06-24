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
 *     is ≈ 200k, not the 1M the API tier allows. Codex bridge estimates are tracked separately
 *     below; interactive rollout telemetry has observed a plan/client cap of 258400.
 *
 * So we pre-filter candidates whose effective window can't hold the probe - instead of wasting a
 * call that returns "Prompt is too long".
 */

import type { ModelProfile } from "../core/model-profiles.js";

/** request_tokens ≈ probe_tokens × this (attachment + conversation + base overhead). */
export const REQUEST_INFLATION = 1.7;

/**
 * Effective SUBSCRIPTION-CLI windows (measured via the bridge), distinct from the profiles' API
 * maxima. Estimates; refine with a dedicated window-probe sweep.
 */
export const BRIDGE_WINDOWS: Record<string, number> = {
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
