/**
 * Cairn - calibration candidate variants (ADR-0005, ADR-0012).
 *
 * A "variant" is a (base model × reasoning effort) tuple, encoded as `"<modelId>@<effort>"`. The
 * candidate set is the active anthropic/openai models (the summarizer pool) at the calibration
 * effort: since ADR-0012 every model is calibrated at exactly `high`, never below.
 */

import { PROFILES, type Ecosystem, type ModelProfile } from "../core/model-profiles.js";
import type { BridgeCli } from "../core/bridge.js";

export type CalibEcosystem = "anthropic" | "openai";

/** Which CLI bridges each ecosystem. */
export function cliFor(ecosystem: CalibEcosystem): BridgeCli {
  return ecosystem === "anthropic" ? "claude" : "codex";
}

/** Map a profile id to the CLI's `--model` value: the full, pinned model id for both CLIs. Claude Code's
 *  family aliases (`opus`/`sonnet`/`haiku`) move to the newest model (`opus` = Opus 5.5), so an alias
 *  would calibrate - and peer-review with - a different model than the profile names. Invalid names
 *  simply fail the bridge call → variant skipped + logged. */
export function cliModelName(baseModelId: string): string {
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

/** Reasoning-effort tiers, lowest first: OpenAI's `none`/`minimal` up to `max` (claude `--effort`, codex
 *  `model_reasoning_effort`). The exact lower-case spelling is required. */
export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_ORDER)[number];

/** The calibration effort (ADR-0012): every candidate and every reviewer runs at exactly this tier. */
export const CALIB_EFFORT: Effort = "high";

function effortRank(effort: string, label: string): number {
  const i = (EFFORT_ORDER as readonly string[]).indexOf(effort);
  if (i < 0) {
    throw new Error(`${label}: effort '${effort}' is not one of ${EFFORT_ORDER.join("|")} (exact lower-case spelling)`);
  }
  return i;
}

/**
 * Throw unless `effort` is a known tier at or above `min`. An empty, unknown or differently-cased value
 * throws too: the bridge silently drops an effort it does not accept (`SAFE_EFFORT`), and the CLI then
 * runs the model's default - `medium` for Opus 5.5 - below the floor.
 */
export function assertMinEffort(effort: string, min: Effort, label = "effort"): Effort {
  if (effortRank(effort, label) < effortRank(min, label)) {
    throw new Error(`${label}: effort '${effort}' is below the '${min}' minimum (ADR-0012)`);
  }
  return effort as Effort;
}

/** Throw unless `effort` is exactly `required` (reviewers and the calibration config, ADR-0012). */
export function assertExactEffort(effort: string, required: Effort, label = "effort"): Effort {
  if (effort !== required) throw new Error(`${label}: effort must be exactly '${required}', got '${effort}' (ADR-0012)`);
  return required;
}

/** Default effort tiers per ecosystem (claude `--effort`, codex `model_reasoning_effort`): `high` only (ADR-0012). */
export const DEFAULT_EFFORTS: Record<CalibEcosystem, string[]> = {
  anthropic: [CALIB_EFFORT],
  openai: [CALIB_EFFORT],
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
 *  by the real compaction itself (failures are skipped + logged), not pre-filtered here. Throws on an
 *  effort below `high` (ADR-0012). */
export function buildVariants(opts: VariantSetOptions = {}): Variant[] {
  const profiles = opts.profiles ?? PROFILES;
  const include = opts.ecosystems ?? ["anthropic", "openai"];
  const out: Variant[] = [];
  for (const p of profiles) {
    if (p.status !== "active" || !isCalibEcosystem(p.ecosystem) || !include.includes(p.ecosystem)) continue;
    const efforts = opts.efforts?.[p.ecosystem] ?? DEFAULT_EFFORTS[p.ecosystem];
    for (const effort of efforts) {
      assertMinEffort(effort, CALIB_EFFORT, `variant '${variantId(p.id, effort)}'`);
      out.push({ id: variantId(p.id, effort), baseModelId: p.id, ecosystem: p.ecosystem, effort });
    }
  }
  return out;
}
