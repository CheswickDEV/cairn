/**
 * Cairn - multi-probe golden set (ADR-0005). Running each candidate over SEVERAL probes and
 * averaging the fidelity reduces single-probe / single-reviewer noise: a more robust score than
 * one probe. Returns the per-model mean plus the per-probe breakdown.
 */

import { createHash } from "node:crypto";
import type { ModelProfile } from "../core/model-profiles.js";
import type { GroundTruth } from "./ground-truth.js";
import type { CompactionRun, Compactor } from "./runner.js";
import type { Reviewer } from "./review.js";
import { runCalibration, reviewBriefs } from "./harness.js";
import { median, stddev, clamp01, fitReviewerEffects, type ModelCalibration, type ReviewRecord, type ReviewObservation } from "./score.js";
import { missingMustSurvive, computeVerbatimScore } from "./review.js";
import type { RunProvenance } from "./provenance.js";
import { loadProbeContext, loadGroundTruth, loadExactSpans } from "./fixtures.js";
import { GOLDEN2_PROBE, GOLDEN2_GROUND_TRUTH, GOLDEN2_EXACT_SPANS } from "./golden-probe-2.js";
import { GOLDEN3_PROBE, GOLDEN3_GROUND_TRUTH, GOLDEN3_EXACT_SPANS } from "./golden-probe-3.js";
import { GOLDEN4_PROBE, GOLDEN4_GROUND_TRUTH, GOLDEN4_EXACT_SPANS } from "./golden-probe-4.js";
import { GOLDEN5_PROBE, GOLDEN5_GROUND_TRUTH, GOLDEN5_EXACT_SPANS } from "./golden-probe-5.js";

export interface GoldenProbe {
  label: string;
  probe: string;
  groundTruth: GroundTruth;
  exactSpans: string[];
}

/** The default golden set: five distinct domains. Averaging fidelity over all of them is far less
 *  noisy than a single probe. Add more here to grow it. */
export function goldenProbes(): GoldenProbe[] {
  return [
    { label: "ocr-beleg", probe: loadProbeContext(), groundTruth: loadGroundTruth(), exactSpans: loadExactSpans() },
    { label: "api-gateway", probe: GOLDEN2_PROBE, groundTruth: GOLDEN2_GROUND_TRUTH, exactSpans: GOLDEN2_EXACT_SPANS },
    { label: "oauth-token", probe: GOLDEN3_PROBE, groundTruth: GOLDEN3_GROUND_TRUTH, exactSpans: GOLDEN3_EXACT_SPANS },
    { label: "db-migration", probe: GOLDEN4_PROBE, groundTruth: GOLDEN4_GROUND_TRUTH, exactSpans: GOLDEN4_EXACT_SPANS },
    { label: "k8s-rollout", probe: GOLDEN5_PROBE, groundTruth: GOLDEN5_GROUND_TRUTH, exactSpans: GOLDEN5_EXACT_SPANS },
  ];
}

/** One probe's result for one variant. Beyond fidelity/confidence it carries what the model decision
 *  needs (ADR-0012): verbosity, reviewer spread + warning, and every single review. */
export interface GoldenProbeResult {
  label: string;
  fidelity: number;
  confidence: number;
  verbosityCoeff: number;
  spread: number;
  highSpreadWarning: boolean;
  outputTokens: number;
  retainedAllMustSurvive: boolean;
  /** Ids of the must-survive items the deterministic check did not find. */
  missingMustSurvive?: string[];
  /** The brief as scored (ADR-0012). */
  brief?: string;
  reviewers: string[];
  reviews: ReviewRecord[];
  /** Mean of the reviews after each reviewer's effect is subtracted (ADR-0012, `reviewerEffects`). */
  fidelityAdjusted?: number;
  /** clamp(1 − spread) of the corrected reviews. */
  confidenceAdjusted?: number;
}

export interface GoldenModelResult {
  modelId: string;
  baseModelId: string;
  effort: string;
  meanFidelity: number;
  meanConfidence: number;
  /** Mean verbosityCoeff over the probes (each probe's coefficient is relative to that probe's median). */
  meanVerbosityCoeff: number;
  /** How many probes raised the high-spread warning. */
  highSpreadWarnings: number;
  probesScored: number;
  /** Mean of `fidelityAdjusted` over the probes (ADR-0012). */
  meanFidelityAdjusted?: number;
  meanConfidenceAdjusted?: number;
  perProbe: GoldenProbeResult[];
}

export interface GoldenResult {
  date: string;
  /** Effort the reviewers ran at (live runs; ADR-0012: exactly `high`). */
  reviewerEffort?: string;
  probes: string[];
  perModel: GoldenModelResult[];
  floorProposal: number | null;
  /** Least-squares reviewer effects over this run's reviews, centred on 0 (ADR-0012; `fitReviewerEffects`). */
  reviewerEffects?: Record<string, number>;
  /** Median of `meanFidelityAdjusted` over the models. */
  floorProposalAdjusted?: number | null;
  /** Why no reviewer correction was recorded (e.g. one reviewer per brief: effects not identifiable). */
  reviewerEffectsSkipped?: string;
  /** Code and CLI versions behind the run (set by the CLI). */
  provenance?: RunProvenance;
  /** SHA-256 of the compaction system prompt (set by the CLI; ADR-0013, `compactionPromptSha256`). */
  promptSha256?: string;
  /** SHA-256 of the reviewer prompt (set by the CLI for a live run; ADR-0012, `reviewerPromptSha256`). An
   *  artifact without it was scored by the reviewer that saw only the ground truth. */
  reviewerPromptSha256?: string;
  /** A re-review (`--rereview`): the artifact whose stored briefs were scored again. */
  rereviewOf?: { path: string; sha256: string };
}

export interface RunGoldenSetInput {
  probes: GoldenProbe[];
  candidates: string[];
  profiles: ModelProfile[];
  /** Per-probe compactor (offline: makeFixtureCompactor(gt); real: a gt-agnostic account compactor). */
  makeCompactor: (gt: GroundTruth) => Compactor;
  reviewer: Reviewer;
  reviewerPool?: string[];
  reviewersPerBrief?: number;
  reviewerEffort?: string;
  concurrency?: number;
  date: string;
  now?: () => number;
  onSkip?: (label: string, error: unknown) => void;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export async function runGoldenSet(input: RunGoldenSetInput): Promise<GoldenResult> {
  const perProbe: { label: string; models: ModelCalibration[] }[] = [];
  for (const gp of input.probes) {
    const art = await runCalibration({
      candidates: input.candidates,
      profiles: input.profiles,
      compactor: input.makeCompactor(gp.groundTruth),
      reviewer: input.reviewer,
      reviewerPool: input.reviewerPool,
      reviewersPerBrief: input.reviewersPerBrief,
      reviewerEffort: input.reviewerEffort,
      concurrency: input.concurrency,
      date: input.date,
      now: input.now,
      groundTruth: gp.groundTruth,
      probe: gp.probe,
      exactSpans: gp.exactSpans,
      onSkip: input.onSkip,
    });
    perProbe.push({ label: gp.label, models: art.models });
  }
  return collectGolden(input.date, input.reviewerEffort, input.probes.map((p) => p.label), perProbe);
}

export interface RereviewInput {
  /** The golden artifact whose stored briefs are scored again. */
  res: GoldenResult;
  /** The current probes; each of the artifact's probes must be among them (by label). */
  probes: GoldenProbe[];
  profiles: ModelProfile[];
  reviewer: Reviewer;
  reviewerPool?: string[];
  reviewersPerBrief?: number;
  reviewerEffort?: string;
  concurrency?: number;
  date: string;
  onSkip?: (label: string, error: unknown) => void;
}

/**
 * Score the stored briefs of a golden artifact again, with the current reviewer, ground truth and probes as
 * the source (ADR-0012): no compaction, only reviews. Each brief keeps its model, probe and output tokens; a
 * model the run did not score on a probe stays out there too. Throws before any review when a probe is
 * unknown, its recorded contents differ from the current probe, or a scored brief was not stored.
 */
export async function rereviewGoldenResult(input: RereviewInput): Promise<GoldenResult> {
  const { res } = input;
  const byLabel = new Map(input.probes.map((p) => [p.label, p]));
  const recorded = new Map(((res as { probeInfo?: { label: string; sha256: string }[] }).probeInfo ?? []).map((p) => [p.label, p.sha256]));
  const plan = res.probes.map((label) => {
    const gp = byLabel.get(label);
    if (!gp) throw new Error(`rereview: unknown probe '${label}'`);
    const sha = recorded.get(label);
    if (sha !== undefined && sha !== createHash("sha256").update(gp.probe, "utf8").digest("hex")) {
      throw new Error(`rereview: probe '${label}' differs from the one the briefs were made from`);
    }
    const runs: CompactionRun[] = [];
    for (const m of res.perModel) {
      const p = m.perProbe.find((x) => x.label === label);
      if (!p) continue;
      if (typeof p.brief !== "string") throw new Error(`rereview: no stored brief for ${m.modelId} on '${label}'`);
      runs.push({ modelId: m.modelId, brief: p.brief, outputTokens: p.outputTokens, runtimeMs: 0 });
    }
    return { gp, runs };
  });
  const perProbe: { label: string; models: ModelCalibration[] }[] = [];
  for (const { gp, runs } of plan) {
    const { models } = await reviewBriefs({
      runs,
      groundTruth: gp.groundTruth,
      source: gp.probe,
      profiles: input.profiles,
      reviewer: input.reviewer,
      reviewerPool: input.reviewerPool,
      reviewersPerBrief: input.reviewersPerBrief,
      concurrency: input.concurrency,
      onSkip: input.onSkip,
    });
    perProbe.push({ label: gp.label, models });
  }
  return collectGolden(input.date, input.reviewerEffort, res.probes, perProbe);
}

/** Per-model means over the probes, the floor proposal and the reviewer correction of one golden run. */
function collectGolden(
  date: string,
  reviewerEffort: string | undefined,
  probes: string[],
  perProbe: { label: string; models: ModelCalibration[] }[],
): GoldenResult {
  const byVariant = new Map<string, GoldenModelResult>();
  for (const { label, models } of perProbe) {
    for (const m of models) {
      const e =
        byVariant.get(m.modelId) ??
        {
          modelId: m.modelId, baseModelId: m.baseModelId, effort: m.effort,
          meanFidelity: 0, meanConfidence: 0, meanVerbosityCoeff: 0, highSpreadWarnings: 0, probesScored: 0, perProbe: [],
        };
      e.perProbe.push({
        label,
        fidelity: m.fidelityScore,
        confidence: m.confidence,
        verbosityCoeff: m.verbosityCoeff,
        spread: m.spread,
        highSpreadWarning: m.highSpreadWarning,
        outputTokens: m.outputTokens,
        retainedAllMustSurvive: m.retainedAllMustSurvive,
        ...(m.missingMustSurvive ? { missingMustSurvive: m.missingMustSurvive } : {}),
        ...(m.brief !== undefined ? { brief: m.brief } : {}),
        reviewers: m.reviewers,
        reviews: m.reviews ?? [],
      });
      byVariant.set(m.modelId, e);
    }
  }

  const perModel = [...byVariant.values()].map((e) => ({
    ...e,
    meanFidelity: mean(e.perProbe.map((p) => p.fidelity)),
    meanConfidence: mean(e.perProbe.map((p) => p.confidence)),
    meanVerbosityCoeff: mean(e.perProbe.map((p) => p.verbosityCoeff)),
    highSpreadWarnings: e.perProbe.filter((p) => p.highSpreadWarning).length,
    probesScored: e.perProbe.length,
  }));

  // Floor proposal: the median mean-fidelity across models (robust central value), or null if empty.
  const floorProposal = perModel.length ? median(perModel.map((m) => m.meanFidelity)) : null;
  // The correction is an add-on: it must never cost a paid run its artifact (ADR-0012).
  let corrected: ReturnType<typeof correctForReviewers> = null;
  let skipped: string | undefined;
  try {
    corrected = correctForReviewers([perModel]);
  } catch (e) {
    skipped = e instanceof Error ? e.message : String(e);
  }

  return {
    date,
    ...(reviewerEffort ? { reviewerEffort } : {}),
    probes,
    perModel: corrected ? corrected.runs[0] : perModel,
    floorProposal,
    ...(corrected
      ? {
          reviewerEffects: corrected.effects,
          floorProposalAdjusted: median(corrected.runs[0].map((m) => m.meanFidelityAdjusted!).filter(Number.isFinite)),
        }
      : {}),
    ...(skipped ? { reviewerEffectsSkipped: skipped } : {}),
  };
}

/**
 * Reviewer-effect correction over one or more runs (ADR-0012): one joint least-squares fit over every
 * review, then each probe result gets `fidelityAdjusted` / `confidenceAdjusted` and each model the means.
 * Briefs are told apart per run, model and probe. Returns null when there are no reviews to fit.
 */
function correctForReviewers(runs: GoldenModelResult[][]): { effects: Record<string, number>; runs: GoldenModelResult[][] } | null {
  const obs: ReviewObservation[] = [];
  runs.forEach((perModel, i) => {
    for (const m of perModel) {
      for (const p of m.perProbe) {
        for (const r of p.reviews) obs.push({ brief: `${i}|${m.modelId}|${p.label}`, reviewer: r.reviewerModelId, fidelity: r.fidelity });
      }
    }
  });
  if (obs.length === 0) return null;
  const e = fitReviewerEffects(obs);
  const adjust = (m: GoldenModelResult): GoldenModelResult => {
    const perProbe = m.perProbe.map((p) => {
      if (!p.reviews.length) return p;
      const ys = p.reviews.map((r) => r.fidelity - (e.get(r.reviewerModelId) ?? 0));
      return { ...p, fidelityAdjusted: mean(ys), confidenceAdjusted: clamp01(1 - stddev(ys)) };
    });
    const scored = perProbe.filter((p) => p.fidelityAdjusted !== undefined);
    return {
      ...m,
      perProbe,
      meanFidelityAdjusted: scored.length ? mean(scored.map((p) => p.fidelityAdjusted!)) : NaN,
      meanConfidenceAdjusted: scored.length ? mean(scored.map((p) => p.confidenceAdjusted!)) : NaN,
    };
  };
  return { effects: Object.fromEntries(e), runs: runs.map((perModel) => perModel.map(adjust)) };
}

/** One input for `--pool`: where it came from, its SHA-256, the parsed golden result. */
export interface PoolInput {
  path: string;
  sha256: string;
  res: GoldenResult;
}

/** JSON with sorted keys: the same for a re-serialized copy of an artifact. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * What identifies a run: each (model, probe) brief with its reviewers' own scores, in any order. Derived
 * values (fidelities, the hard verbatim score, missing items) are left out, so a re-scored copy matches. A
 * row with neither brief nor reviews (an old artifact) falls back to the whole row, derived values included.
 */
function runFingerprint(r: GoldenResult): string {
  const rows = r.perModel.flatMap((m) =>
    m.perProbe.map((p) => {
      const reviews = (p.reviews ?? [])
        .map((v) => canonicalJson([v.reviewerModelId, v.rubric?.recall, v.rubric?.hallucination, v.rubric?.supersession]))
        .sort();
      return p.brief == null && reviews.length === 0
        ? canonicalJson([m.modelId, p])
        : canonicalJson([m.modelId, p.label, p.brief ?? null, reviews]);
    }),
  );
  return createHash("sha256").update(rows.sort().join("\n")).digest("hex");
}

/** What the briefs of a run are: each stored (model, probe) brief, in any order; null when none is stored. */
function briefsFingerprint(r: GoldenResult): string | null {
  const rows = r.perModel.flatMap((m) =>
    m.perProbe.filter((p) => typeof p.brief === "string").map((p) => canonicalJson([m.modelId, p.label, p.brief])),
  );
  return rows.length ? createHash("sha256").update(rows.sort().join("\n")).digest("hex") : null;
}

/**
 * Only runs of the same configuration pool (ADR-0012): no artifact twice (by file hash, or by its briefs and
 * reviews when re-serialized, reordered or re-scored), the same probes (and probe contents, where recorded),
 * the same models, the same reviewer effort and the same compaction prompt (ADR-0013). An artifact without a
 * prompt hash predates it and ran the prompt before 2.0.0: it pools only with others without one. The same
 * holds for the reviewer prompt: an artifact without its hash was scored without the source. Two inputs with
 * the same stored briefs are one run scored twice (a re-review), never two runs. Throws naming the input;
 * returns notes on what could not be compared.
 */
export function checkPoolInputs(inputs: PoolInput[]): string[] {
  if (inputs.length === 0) throw new Error("--pool needs at least one golden artifact");
  const first = inputs[0];
  const models = (r: GoldenResult) => r.perModel.map((m) => m.modelId).sort().join(",");
  const hashes = (r: GoldenResult) => (r as { probeInfo?: { sha256: string }[] }).probeInfo?.map((p) => p.sha256).join(",");
  const seen = new Set<string>();
  const runs = new Map<string, string>();
  const notes: string[] = [];
  let probeRef: PoolInput | undefined;
  const briefSets = new Map<string, string>();
  for (const i of inputs) {
    const wellFormed =
      Array.isArray(i.res.perModel) &&
      Array.isArray(i.res.probes) &&
      i.res.perModel.every(
        (m) =>
          Array.isArray(m?.perProbe) &&
          m.perProbe.every(
            (p) => p && typeof p === "object" && (p.reviews === undefined || (Array.isArray(p.reviews) && p.reviews.every((v) => v && typeof v === "object"))),
          ),
      );
    if (!wellFormed) throw new Error(`${i.path}: not a golden artifact`);
    if (seen.has(i.sha256)) throw new Error(`${i.path}: the same artifact twice`);
    seen.add(i.sha256);
    const run = runFingerprint(i.res);
    const twin = runs.get(run);
    if (twin) throw new Error(`${i.path}: the same run as ${twin} (identical results)`);
    runs.set(run, i.path);
    const briefs = briefsFingerprint(i.res);
    if (briefs) {
      const twinBriefs = briefSets.get(briefs);
      if (twinBriefs) throw new Error(`${i.path}: the same briefs as ${twinBriefs} (a re-review of the same run)`);
      briefSets.set(briefs, i.path);
    }
    if (i.res.probes.join(",") !== first.res.probes.join(",")) throw new Error(`${i.path}: other probes than ${first.path}`);
    if (models(i.res) !== models(first.res)) throw new Error(`${i.path}: other models than ${first.path}`);
    if (i.res.reviewerEffort !== first.res.reviewerEffort) throw new Error(`${i.path}: other reviewer effort than ${first.path}`);
    if (i.res.promptSha256 !== first.res.promptSha256) throw new Error(`${i.path}: another compaction prompt than ${first.path}`);
    if (!i.res.promptSha256) notes.push(`${i.path}: no promptSha256 (written before it was recorded), so its compaction prompt is not compared`);
    if (i.res.reviewerPromptSha256 !== first.res.reviewerPromptSha256) throw new Error(`${i.path}: another reviewer prompt than ${first.path}`);
    const h = hashes(i.res);
    if (!h) {
      notes.push(`${i.path}: no probeInfo (written before it was recorded), so its probe contents are not compared`);
    } else if (!probeRef) {
      probeRef = i;
    } else if (h !== hashes(probeRef.res)) {
      throw new Error(`${i.path}: other probe contents than ${probeRef.path}`);
    }
  }
  return notes;
}

/** One model across pooled golden runs (ADR-0012). */
export interface PooledModelResult {
  modelId: string;
  baseModelId: string;
  effort: string;
  /** Probe runs pooled (probes × runs). */
  probeRuns: number;
  meanFidelity: number;
  meanFidelityAdjusted: number;
  meanConfidenceAdjusted: number;
  meanVerbosityCoeff: number;
  /** Deterministic re-check of the stored briefs with the current ground truth (null for an unknown probe). */
  missingMustSurvive: number | null;
  mustSurviveChecked: number;
  briefsRetainingAll: number;
}

export interface PooledGoldenResult {
  runs: number;
  reviewerEffects: Record<string, number>;
  perModel: PooledModelResult[];
  /** Median over the models of the raw / corrected pooled means. */
  floorProposal: number | null;
  floorProposalAdjusted: number | null;
}

/**
 * Pool several golden artifacts of the same configuration (ADR-0012): every probe run counts once, the
 * reviewer effects come from one fit over all reviews, and the stored briefs are checked again against the
 * current ground truth of their probe (`probes`, by label). No model call.
 */
export function poolGoldenResults(results: GoldenResult[], probes: GoldenProbe[] = goldenProbes()): PooledGoldenResult {
  if (results.length === 0) throw new Error("pool: no golden result");
  const corrected = correctForReviewers(results.map((r) => r.perModel));
  if (!corrected) throw new Error("pool: the artifacts hold no reviews");
  const gtBy = new Map(probes.map((p) => [p.label, p.groundTruth]));
  const byModel = new Map<string, GoldenModelResult[]>();
  for (const run of corrected.runs) for (const m of run) byModel.set(m.modelId, [...(byModel.get(m.modelId) ?? []), m]);
  const perModel: PooledModelResult[] = [...byModel.values()].map((ms) => {
    const pp = ms.flatMap((m) => m.perProbe);
    const adj = pp.filter((p) => p.fidelityAdjusted !== undefined); // a probe run whose reviews all failed has none
    let missing: number | null = 0;
    let checked = 0;
    let retaining = 0;
    for (const p of pp) {
      const gt = gtBy.get(p.label);
      if (!gt || p.brief === undefined) {
        missing = null;
        continue;
      }
      const miss = missingMustSurvive(p.brief, gt);
      if (missing !== null) missing += miss.length;
      checked += gt.mustSurvive.length;
      if (miss.length === 0 && computeVerbatimScore(p.brief, gt) === 1) retaining++;
    }
    return {
      modelId: ms[0].modelId,
      baseModelId: ms[0].baseModelId,
      effort: ms[0].effort,
      probeRuns: pp.length,
      meanFidelity: mean(pp.map((p) => p.fidelity)),
      meanFidelityAdjusted: adj.length ? mean(adj.map((p) => p.fidelityAdjusted!)) : NaN,
      meanConfidenceAdjusted: adj.length ? mean(adj.map((p) => p.confidenceAdjusted!)) : NaN,
      meanVerbosityCoeff: mean(pp.map((p) => p.verbosityCoeff)),
      missingMustSurvive: missing,
      mustSurviveChecked: checked,
      briefsRetainingAll: retaining,
    };
  });
  return {
    runs: results.length,
    reviewerEffects: corrected.effects,
    perModel,
    floorProposal: perModel.length ? median(perModel.map((m) => m.meanFidelity)) : null,
    floorProposalAdjusted: (() => {
      const xs = perModel.map((m) => m.meanFidelityAdjusted).filter(Number.isFinite);
      return xs.length ? median(xs) : null;
    })(),
  };
}
