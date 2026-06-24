#!/usr/bin/env node
/**
 * Cairn - calibration CLI (`npm run calibrate`).
 *
 * Default = OFFLINE/fixture mode: deterministic compactor + heuristic reviewer, no egress;
 * reproducible artifact under calibration/results/<date>.json.
 *
 * `--real` = LIVE cross-ecosystem calibration over the account sessions: every (model × effort)
 * variant compacts the probe (`claude -p --effort …` / `codex exec -c model_reasoning_effort=…`),
 * then ≥2 strongest FOREIGN base models peer-review each brief (blind). Unreachable variants are
 * logged + skipped. Writes the artifact + floor proposal; it does NOT flip the source profiles
 * (the floor needs manual sign-off, ADR-0005).
 */

import { PROFILES } from "../core/model-profiles.js";
import { makeFixtureCompactor, estimateTokens } from "./runner.js";
import { heuristicReviewer } from "./review.js";
import { loadGroundTruth, loadProbeContext } from "./fixtures.js";
import { partitionByWindow } from "./window-fit.js";
import { runCalibration } from "./harness.js";
import { applyCalibration, persistArtifact, bestPerBaseModel } from "./writer.js";
import { buildVariants, parseVariant, type CalibEcosystem } from "./variants.js";
import { makeAccountCompactor } from "./account-compactor.js";
import { makeModelReviewer } from "./model-reviewer.js";
import { buildLargeProbe, LARGE_GROUND_TRUTH } from "./large-probe.js";
import { runGoldenSet, goldenProbes } from "./golden-set.js";
import type { GroundTruth } from "./ground-truth.js";
import type { Compactor } from "./runner.js";
import type { Reviewer } from "./review.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LARGE_VARIANTS = [
  "claude-opus-4-8@high",
  "claude-opus-4-8@xhigh",
  "claude-opus-4-8@max",
  "claude-sonnet-4-6@high",
  "claude-sonnet-4-6@xhigh",
  "claude-haiku-4-5-20251001@high",
  "claude-haiku-4-5-20251001@xhigh",
];
const LARGE_REVIEWER_POOL = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "gpt-5.5", "gpt-5.4"];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function envEfforts(name: string): string[] | undefined {
  const raw = process.env[name];
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

async function main(): Promise<void> {
  const real = process.argv.includes("--real");
  const out = process.stdout;
  const date = isoDate(new Date());
  const gt = loadGroundTruth();

  // ---- GOLDEN SET (multi-probe) ----
  if (process.argv.includes("--golden")) {
    const probes = goldenProbes();
    const reviewerEffort = process.env.CAIRN_CALIB_REVIEWER_EFFORT ?? "high";
    const explicit = envEfforts("CAIRN_CALIB_VARIANTS");
    let candidates: string[];
    let makeCompactor: (g: GroundTruth) => Compactor;
    let reviewer: Reviewer;
    let reviewerPool: string[] | undefined;
    let reviewersPerBrief: number;
    let concurrency: number;

    if (real) {
      const variants = buildVariants({
        ecosystems: ["anthropic", "openai"],
        efforts: { anthropic: envEfforts("CAIRN_CALIB_EFFORTS_ANTHROPIC"), openai: envEfforts("CAIRN_CALIB_EFFORTS_OPENAI") },
      });
      candidates = explicit ?? variants.map((v) => v.id);
      const timeoutMs = Number(process.env.CAIRN_CALIB_TIMEOUT_MS ?? 120_000);
      const maxTokens = Number(process.env.CAIRN_CALIB_MAXTOK ?? 4096);
      makeCompactor = () => makeAccountCompactor({ timeoutMs, maxTokens });
      reviewer = makeModelReviewer({ effort: reviewerEffort, timeoutMs });
      reviewerPool = envEfforts("CAIRN_CALIB_REVIEWER_POOL") ?? LARGE_REVIEWER_POOL;
      reviewersPerBrief = Number(process.env.CAIRN_CALIB_REVIEWERS ?? 3);
      concurrency = Number(process.env.CAIRN_CALIB_CONCURRENCY ?? 3);
      out.write(`Cairn GOLDEN SET (LIVE) — ${date} — probes: ${probes.map((p) => p.label).join(", ")}\n`);
    } else {
      candidates = explicit ?? PROFILES.filter((p) => p.status === "active").map((p) => p.id);
      makeCompactor = (g) => makeFixtureCompactor(g);
      reviewer = heuristicReviewer;
      reviewersPerBrief = 2;
      concurrency = 1;
      out.write(`Cairn GOLDEN SET (OFFLINE/fixture) — ${date} — probes: ${probes.map((p) => p.label).join(", ")}\n`);
    }

    const skips: string[] = [];
    const res = await runGoldenSet({
      probes,
      candidates,
      profiles: PROFILES,
      makeCompactor,
      reviewer,
      reviewerPool,
      reviewersPerBrief,
      concurrency,
      date,
      onSkip: (label, err) => {
        const m = err instanceof Error ? err.message : String(err);
        skips.push(`${label}: ${m.slice(0, 100)}`);
        process.stderr.write(`  ⏭ ${label}: ${m.slice(0, 100)}\n`);
      },
    });

    mkdirSync("calibration/results", { recursive: true });
    const gpath = join("calibration/results", `${date}-golden.json`);
    writeFileSync(gpath, JSON.stringify(res, null, 2) + "\n", "utf8");
    out.write(`\nWrote ${gpath} (skipped ${skips.length})\n\nPer model (mean fidelity over ${res.probes.length} probes):\n`);
    for (const m of [...res.perModel].sort((a, b) => b.meanFidelity - a.meanFidelity)) {
      const pp = m.perProbe.map((p) => `${p.label}=${p.fidelity.toFixed(3)}`).join("  ");
      out.write(`  ${m.modelId.padEnd(30)} mean=${m.meanFidelity.toFixed(3)} conf=${m.meanConfidence.toFixed(2)}  [${pp}]\n`);
    }
    out.write(`\nFloor proposal (median mean-fidelity): ${res.floorProposal?.toFixed(3) ?? "n/a"} — manual sign-off.\n`);
    return;
  }

  if (!real) {
    const candidates = PROFILES.filter((p) => p.status === "active").map((p) => p.id);
    const artifact = await runCalibration({
      candidates,
      profiles: PROFILES,
      compactor: makeFixtureCompactor(gt),
      reviewer: heuristicReviewer,
      date,
      groundTruth: gt,
    });
    const path = persistArtifact("calibration/results", artifact);
    const updated = applyCalibration(PROFILES, artifact);
    out.write(`Cairn calibration (OFFLINE/fixture mode) — ${date}\n`);
    out.write(`Wrote versioned artifact: ${path}\n`);
    out.write(`Floor proposal: ${artifact.floorProposal ?? "n/a"} (confirm manually)\n`);
    for (const m of artifact.models) {
      out.write(
        `  ${m.modelId.padEnd(28)} fidelity=${m.fidelityScore.toFixed(3)} ` +
          `verbosity=${m.verbosityCoeff.toFixed(2)} confidence=${m.confidence.toFixed(2)}\n`,
      );
    }
    out.write(
      `Note: ${updated.filter((p) => p.summarizer.calibrated).length}/${updated.length} profiles would flip ` +
        `to calibrated; source left unchanged (floor needs manual sign-off).\n`,
    );
    return;
  }

  // ---- LIVE run ----
  const idx = process.argv.indexOf("--probe");
  const large = process.env.CAIRN_CALIB_PROBE === "large" || (idx >= 0 && process.argv[idx + 1] === "large");
  const explicitVariants = envEfforts("CAIRN_CALIB_VARIANTS"); // reuse comma-split helper

  const reviewerEffort = process.env.CAIRN_CALIB_REVIEWER_EFFORT ?? "high";
  const concurrency = Number(process.env.CAIRN_CALIB_CONCURRENCY ?? (large ? 2 : 3));
  const reviewersPerBrief = Number(process.env.CAIRN_CALIB_REVIEWERS ?? (large ? 3 : 2));
  const timeoutMs = Number(process.env.CAIRN_CALIB_TIMEOUT_MS ?? (large ? 900_000 : 120_000));

  let candidates: string[];
  let groundTruth = gt;
  let probe: string | undefined;
  let exactSpans: string[] | undefined;
  let reviewerPool: string[] | undefined;
  let maxTokens = 4096;
  let suffix = "";

  if (large) {
    const targetTokens = Number(process.env.CAIRN_CALIB_PROBE_TOKENS ?? 800_000);
    const lp = buildLargeProbe(targetTokens);
    probe = lp.probe;
    exactSpans = lp.exactSpans;
    groundTruth = LARGE_GROUND_TRUTH;
    candidates = explicitVariants ?? LARGE_VARIANTS;
    reviewerPool = envEfforts("CAIRN_CALIB_REVIEWER_POOL") ?? LARGE_REVIEWER_POOL;
    maxTokens = Number(process.env.CAIRN_CALIB_MAXTOK ?? 8192);
    suffix = "-large";
    out.write(`Cairn calibration (LIVE high-fill ~${Math.round(targetTokens / 1000)}k, Anthropic-only candidates) — ${date}\n`);
    out.write(`Probe ≈ ${probe.length} chars (~${Math.round(probe.length / 4000)}k tok). Candidates: ${candidates.length}; reviewer pool: ${reviewerPool.join(", ")}\n`);
  } else {
    const ecosystems = (process.env.CAIRN_CALIB_ECOSYSTEMS?.split(",").map((s) => s.trim()) as CalibEcosystem[]) ?? [
      "anthropic",
      "openai",
    ];
    const variants = buildVariants({
      ecosystems,
      efforts: { anthropic: envEfforts("CAIRN_CALIB_EFFORTS_ANTHROPIC"), openai: envEfforts("CAIRN_CALIB_EFFORTS_OPENAI") },
    });
    candidates = explicitVariants ?? variants.map((v) => v.id);
    out.write(`Cairn calibration (LIVE cross-ecosystem) — ${date}\n`);
    out.write(`Candidates (model×effort): ${candidates.length} | base models: ${[...new Set(variants.map((v) => v.baseModelId))].join(", ")}\n`);
  }
  out.write(`Concurrency ${concurrency}, reviewer effort '${reviewerEffort}', timeout ${timeoutMs}ms. Real account calls…\n`);

  // Item (3): pre-exclude candidates whose effective window can't hold the probe (ADR-0003/0004) -
  // no wasted "Prompt is too long" calls.
  const probeTokens = probe ? estimateTokens(probe) : estimateTokens(loadProbeContext());
  const part = partitionByWindow(candidates, probeTokens, PROFILES, (id) => parseVariant(id).baseModelId);
  for (const e of part.excluded) {
    out.write(
      `  ⊘ pre-excluded ${e.id}: effective window ~${Math.round(e.window / 1000)}k < ~${Math.round(e.request / 1000)}k request\n`,
    );
  }
  candidates = part.fit;
  if (candidates.length === 0) {
    out.write(`No candidate fits the probe (~${Math.round(probeTokens / 1000)}k tok). Use a smaller probe.\n`);
    return;
  }

  const skips: string[] = [];
  const artifact = await runCalibration({
    candidates,
    profiles: PROFILES,
    compactor: makeAccountCompactor({ timeoutMs, maxTokens }),
    reviewer: makeModelReviewer({ effort: reviewerEffort, timeoutMs }),
    reviewerPool,
    reviewersPerBrief,
    concurrency,
    date,
    groundTruth,
    probe,
    exactSpans,
    onSkip: (label, err) => {
      const msg = err instanceof Error ? err.message : String(err);
      skips.push(`${label}: ${msg.slice(0, 120)}`);
      process.stderr.write(`  ⏭ skip ${label}: ${msg.slice(0, 120)}\n`);
    },
  });

  const path = persistArtifact("calibration/results", artifact, suffix);
  out.write(`\nWrote versioned artifact: ${path}\n`);
  out.write(`Scored variants: ${artifact.models.length}/${candidates.length} (skipped ${skips.length})\n\n`);
  out.write(`Per (model × effort):\n`);
  for (const m of [...artifact.models].sort((a, b) => b.fidelityScore - a.fidelityScore)) {
    out.write(
      `  ${m.modelId.padEnd(30)} fidelity=${m.fidelityScore.toFixed(3)} ` +
        `verbosity=${m.verbosityCoeff.toFixed(2)} confidence=${m.confidence.toFixed(2)} ` +
        `tokens=${m.outputTokens}${m.highSpreadWarning ? " ⚠high-spread" : ""}\n`,
    );
  }
  const best = bestPerBaseModel(artifact.models);
  out.write(`\nBest per base model (→ would calibrate):\n`);
  for (const [base, m] of best) {
    out.write(`  ${base.padEnd(28)} effort=${parseVariant(m.modelId).effort} fidelity=${m.fidelityScore.toFixed(3)}\n`);
  }
  for (const note of artifact.notes) out.write(`${note}\n`);
  out.write(`\nFloor proposal: ${artifact.floorProposal ?? "n/a"}. Profile-Flip + Floor erst nach Sichtung (manuell).\n`);
}

main().catch((err) => {
  process.stderr.write(`calibrate: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
