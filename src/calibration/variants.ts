/**
 * Cairn - calibration candidate variants (ADR-0005).
 *
 * A "variant" is a (base model × reasoning effort) tuple - so each model is tested at several
 * thinking depths. Encoded as `"<modelId>@<effort>"`. The candidate set is the cross product of
 * the reachable active anthropic/openai models with per-ecosystem effort tiers.
 */

import { PROFILES, type Ecosystem, type ModelProfile } from "../core/model-profiles.js";
import type { BridgeCli } from "../core/bridge.js";

export type CalibEcosystem = "anthropic" | "openai";

/** Which CLI bridges each ecosystem. */
export function cliFor(ecosystem: CalibEcosystem): BridgeCli {
  return ecosystem === "anthropic" ? "claude" : "codex";
}

/** Map a profile id to the name the CLI actually accepts: Anthropic family alias (opus/sonnet/…),
 *  OpenAI id as-is. Invalid names simply fail the bridge call → variant skipped + logged. */
export function cliModelName(baseModelId: string, ecosystem: CalibEcosystem): string {
  if (ecosystem === "anthropic") {
    for (const fam of ["opus", "sonnet", "haiku", "fable"]) if (baseModelId.includes(fam)) return fam;
  }
  return baseModelId;
}

export interface Variant {
  id: string; // "modelId@effort"
  baseModelId: string;
  ecosystem: CalibEcosystem;
  effort: string;
}

export function variantId(baseModelId: string, effort: string): string {
  return `${baseModelId}@${effort}`;
}

export function parseVariant(id: string): { baseModelId: string; effort: string } {
  const at = id.lastIndexOf("@");
  return at >= 0 ? { baseModelId: id.slice(0, at), effort: id.slice(at + 1) } : { baseModelId: id, effort: "" };
}

/** Default effort tiers per ecosystem (claude `--effort`, codex `model_reasoning_effort`). */
export const DEFAULT_EFFORTS: Record<CalibEcosystem, string[]> = {
  anthropic: ["medium", "high", "xhigh", "max"],
  openai: ["medium", "high", "xhigh"],
};

export interface VariantSetOptions {
  profiles?: ModelProfile[];
  efforts?: Partial<Record<CalibEcosystem, string[]>>;
  /** Which ecosystems to include (default both → cross-ecosystem). */
  ecosystems?: CalibEcosystem[];
}

function isCalibEcosystem(e: Ecosystem): e is CalibEcosystem {
  return e === "anthropic" || e === "openai";
}

/** Build (model × effort) variants for the active anthropic/openai models. Reachability is proven
 *  by the real compaction itself (failures are skipped + logged), not pre-filtered here. */
export function buildVariants(opts: VariantSetOptions = {}): Variant[] {
  const profiles = opts.profiles ?? PROFILES;
  const include = opts.ecosystems ?? ["anthropic", "openai"];
  const out: Variant[] = [];
  for (const p of profiles) {
    if (p.status !== "active" || !isCalibEcosystem(p.ecosystem) || !include.includes(p.ecosystem)) continue;
    const efforts = opts.efforts?.[p.ecosystem] ?? DEFAULT_EFFORTS[p.ecosystem];
    for (const effort of efforts) {
      out.push({ id: variantId(p.id, effort), baseModelId: p.id, ecosystem: p.ecosystem, effort });
    }
  }
  return out;
}
