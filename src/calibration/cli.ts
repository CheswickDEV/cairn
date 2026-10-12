#!/usr/bin/env node
/**
 * Cairn - calibration CLI (`npm run calibrate`).
 *
 * Default = OFFLINE/fixture mode: deterministic compactor + heuristic reviewer, no egress;
 * reproducible artifact under calibration/results/.
 *
 * `--real` = LIVE cross-ecosystem calibration over the account sessions (ADR-0012): every pool model
 * compacts the probe at exactly `high` (`claude -p --effort high` / `codex exec -c
 * model_reasoning_effort=high`), then all OTHER pool models peer-review each brief (blind, full matrix,
 * reviewers at exactly `high`). Unreachable variants are logged + skipped. Writes the artifact + floor
 * proposal; it does NOT flip the source profiles (the floor needs manual sign-off, ADR-0005).
 *
 * `--dry-run` = the live configuration (candidates, reviewer pool, efforts) on the fixture compactor and
 * the heuristic reviewer: no egress; prints how many model calls `--real` would make.
 *
 * `--pool <golden.json>…` = pool golden artifacts of the same configuration without any model call: one
 * reviewer-effect fit over all their reviews, corrected means, and the stored briefs checked again against
 * the current ground truth (ADR-0012). Writes `…-pooled-golden.json` with the inputs' SHA-256.
 *
 * Artifacts: `calibration/results/<date>T<time>Z-<mode>[-golden|-large].json`, never overwritten.
 */

import { PROFILES } from "../core/model-profiles.js";
import { makeFixtureCompactor, estimateTokens } from "./runner.js";
import { heuristicReviewer } from "./review.js";
import { loadGroundTruth, loadProbeContext } from "./fixtures.js";
import { partitionByWindow } from "./window-fit.js";
import { runCalibration } from "./harness.js";
import { applyCalibration, persistArtifact, bestPerBaseModel } from "./writer.js";
import { parseVariant } from "./variants.js";
import { makeAccountCompactor } from "./account-compactor.js";
import { makeModelReviewer } from "./model-reviewer.js";
import { buildLargeProbe, LARGE_GROUND_TRUTH } from "./large-probe.js";
import { runGoldenSet, goldenProbes, poolGoldenResults, type GoldenResult } from "./golden-set.js";
import { resolveCalibConfig, assertCalibPreflight, artifactSuffix, type CalibConfig } from "./calib-config.js";
import { collectProvenance, collectsCliVersions, probeInfo } from "./provenance.js";
import type { GroundTruth } from "./ground-truth.js";
import type { Compactor } from "./runner.js";
import type { Reviewer } from "./review.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const RESULTS_DIR = "calibration/results";

/** `--pool <artifact.json>…`: pool golden artifacts, no model call (ADR-0012). */
function poolArtifacts(paths: string[], now: Date, out: NodeJS.WriteStream): void {
  if (paths.length === 0) throw new Error("--pool needs at least one golden artifact");
  const inputs = paths.map((path) => {
    const body = readFileSync(path, "utf8");
    const res = JSON.parse(body) as GoldenResult;
    if (!Array.isArray(res.perModel) || !Array.isArray(res.probes)) throw new Error(`${path}: not a golden artifact`);
    return { path, sha256: createHash("sha256").update(body).digest("hex"), res };
  });
  const probes = inputs[0].res.probes.join(",");
  for (const i of inputs) {
    if (i.res.probes.join(",") !== probes) throw new Error(`${i.path}: other probes than ${inputs[0].path}`);
  }
  const pooled = poolGoldenResults(inputs.map((i) => i.res));
  const date = isoDate(now);
  const time = now.toISOString().slice(10, 19).replace(/:/g, "-");
  const provenance = collectProvenance({ live: false });
  const path = persistArtifact(
    RESULTS_DIR,
    { date, inputs: inputs.map(({ path, sha256 }) => ({ path, sha256 })), probes: inputs[0].res.probes, ...pooled, provenance },
    `${time}Z-pooled-golden`,
  );
  out.write(`Cairn POOLED GOLDEN SET — ${pooled.runs} runs, probes: ${probes} (no model call)\n`);
  out.write(`Wrote ${path}\n\nReviewer effects (least squares, centred): `);
  out.write(Object.entries(pooled.reviewerEffects).map(([r, e]) => `${r} ${e >= 0 ? "+" : ""}${e.toFixed(4)}`).join(", ") + "\n\n");
  out.write("Per model (probe runs; raw mean; corrected mean; corrected confidence; verbosity; deterministic must-survive):\n");
  for (const m of [...pooled.perModel].sort((a, b) => b.meanFidelityAdjusted - a.meanFidelityAdjusted)) {
    const det = m.missingMustSurvive === null ? "n/a" : `missed ${m.missingMustSurvive}/${m.mustSurviveChecked}, ${m.briefsRetainingAll}/${m.probeRuns} briefs keep all`;
    out.write(
      `  ${m.modelId.padEnd(30)} n=${m.probeRuns} raw=${m.meanFidelity.toFixed(4)} corrected=${m.meanFidelityAdjusted.toFixed(4)} ` +
        `conf=${m.meanConfidenceAdjusted.toFixed(3)} verbosity=${m.meanVerbosityCoeff.toFixed(3)}  [${det}]\n`,
    );
  }
  out.write(
    `\nFloor proposal (median of the means): raw ${pooled.floorProposal?.toFixed(4) ?? "n/a"}, corrected ` +
      `${pooled.floorProposalAdjusted?.toFixed(4) ?? "n/a"} — manual sign-off.\n`,
  );
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface CallCount {
  compactions: number;
  reviews: number;
}

/** The compactor/reviewer seams for the mode: real bridge calls, or fixtures (offline / dry run).
 *  Every call is counted, so a dry run reports what `--real` would spend. */
function seams(cfg: CalibConfig, calls: CallCount): { makeCompactor: (g: GroundTruth) => Compactor; reviewer: Reviewer } {
  const real = cfg.mode === "real";
  const account = real ? makeAccountCompactor({ timeoutMs: cfg.timeoutMs, maxTokens: cfg.maxTokens }) : undefined;
  const base: Reviewer = real ? makeModelReviewer({ effort: cfg.reviewerEffort, timeoutMs: cfg.timeoutMs }) : heuristicReviewer;
  return {
    makeCompactor: (g) => {
      const c = account ?? makeFixtureCompactor(g);
      return (req) => {
        calls.compactions++;
        return c(req);
      };
    },
    reviewer: (req) => {
      calls.reviews++;
      return base(req);
    },
  };
}

function modeLabel(cfg: CalibConfig): string {
  return cfg.mode === "real" ? "LIVE" : cfg.mode === "dry-run" ? "DRY RUN, no egress" : "OFFLINE/fixture";
}

function writeCallSummary(out: NodeJS.WriteStream, cfg: CalibConfig, calls: CallCount): void {
  if (cfg.mode === "offline") return;
  const total = calls.compactions + calls.reviews;
  const what = cfg.mode === "dry-run" ? "A --real run would make" : "Model calls made";
  out.write(`${what}: ${total} (${calls.compactions} briefs + ${calls.reviews} reviews)\n`);
}

async function main(): Promise<void> {
  const now = new Date();
  const date = isoDate(now);
  const out = process.stdout;
  const poolAt = process.argv.indexOf("--pool");
  if (poolAt >= 0) return poolArtifacts(process.argv.slice(poolAt + 1), now, out);
  // Validates candidates, reviewer pool and efforts (ADR-0012); throws before any model call.
  const cfg = resolveCalibConfig(process.env, process.argv);
  const live = cfg.mode !== "offline";
  if (live) assertCalibPreflight(cfg);
  const calls: CallCount = { compactions: 0, reviews: 0 };
  const { makeCompactor, reviewer } = seams(cfg, calls);
  const suffix = artifactSuffix(now, cfg.mode, cfg.probe);
  // Commit always; CLI versions only for a real run (a dry run must not start claude or codex).
  const provenance = collectProvenance({ live: collectsCliVersions(cfg.mode) });
  const skips: string[] = [];
  const onSkip = (label: string, err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    skips.push(`${label}: ${msg.slice(0, 120)}`);
    process.stderr.write(`  ⏭ skip ${label}: ${msg.slice(0, 120)}\n`);
  };
  const configLine = () =>
    `Candidates: ${cfg.candidates.length} (${cfg.candidates.join(", ")})\n` +
    `Reviewer pool: ${cfg.reviewerPool?.join(", ")}; ${cfg.reviewersPerBrief} reviewers per brief at effort ` +
    `'${cfg.reviewerEffort}'. Concurrency ${cfg.concurrency}, timeout ${cfg.timeoutMs}ms.\n`;

  // ---- GOLDEN SET (multi-probe) ----
  if (cfg.probe === "golden") {
    const probes = goldenProbes();
    out.write(`Cairn GOLDEN SET (${modeLabel(cfg)}) — ${date} — probes: ${probes.map((p) => p.label).join(", ")}\n`);
    if (live) out.write(configLine());
    const res = await runGoldenSet({
      probes,
      candidates: cfg.candidates,
      profiles: PROFILES,
      makeCompactor,
      reviewer,
      reviewerPool: cfg.reviewerPool,
      reviewersPerBrief: cfg.reviewersPerBrief,
      reviewerEffort: live ? cfg.reviewerEffort : undefined,
      concurrency: cfg.concurrency,
      date,
      onSkip,
    });
    const info = probes.map((p) => probeInfo(p.label, p.probe));
    const gpath = persistArtifact(RESULTS_DIR, { ...res, probeInfo: info, provenance }, suffix);
    out.write(`\nWrote ${gpath} (skipped ${skips.length})\n\nPer model (mean over ${res.probes.length} probes):\n`);
    for (const m of [...res.perModel].sort((a, b) => b.meanFidelity - a.meanFidelity)) {
      const pp = m.perProbe.map((p) => `${p.label}=${p.fidelity.toFixed(3)}`).join("  ");
      out.write(
        `  ${m.modelId.padEnd(30)} mean=${m.meanFidelity.toFixed(3)} conf=${m.meanConfidence.toFixed(2)} ` +
          `verbosity=${m.meanVerbosityCoeff.toFixed(2)}${m.highSpreadWarnings ? ` ⚠high-spread×${m.highSpreadWarnings}` : ""}  [${pp}]\n`,
      );
    }
    out.write(
      `\nFloor proposal (median mean-fidelity): ${res.floorProposal?.toFixed(3) ?? "n/a"}; reviewer-corrected ` +
        `${res.floorProposalAdjusted?.toFixed(3) ?? "n/a"} — manual sign-off.\n`,
    );
    writeCallSummary(out, cfg, calls);
    return;
  }

  // ---- OFFLINE single probe ----
  if (!live) {
    const gt = loadGroundTruth();
    const artifact = await runCalibration({
      candidates: cfg.candidates,
      profiles: PROFILES,
      compactor: makeCompactor(gt),
      reviewer,
      reviewersPerBrief: cfg.reviewersPerBrief,
      date,
      groundTruth: gt,
    });
    const path = persistArtifact(RESULTS_DIR, { ...artifact, probeInfo: [probeInfo("standard", loadProbeContext())], provenance }, suffix);
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

  // ---- LIVE / DRY RUN: single standard probe or high-fill probe ----
  let groundTruth = loadGroundTruth();
  let probe: string | undefined;
  let exactSpans: string[] | undefined;
  if (cfg.probe === "large") {
    const targetTokens = cfg.probeTokens ?? 800_000;
    const lp = buildLargeProbe(targetTokens);
    probe = lp.probe;
    exactSpans = lp.exactSpans;
    groundTruth = LARGE_GROUND_TRUTH;
    out.write(`Cairn calibration (${modeLabel(cfg)}; high-fill ~${Math.round(targetTokens / 1000)}k) — ${date}\n`);
    out.write(`Probe ≈ ${probe.length} chars (~${Math.round(probe.length / 4000)}k tok).\n`);
  } else {
    out.write(`Cairn calibration (${modeLabel(cfg)}; cross-ecosystem) — ${date}\n`);
  }
  out.write(configLine());

  // Pre-exclude candidates whose effective bridge window can't hold the probe (ADR-0003/0004) -
  // no wasted "Prompt is too long" calls.
  const probeTokens = probe ? estimateTokens(probe) : estimateTokens(loadProbeContext());
  const part = partitionByWindow(cfg.candidates, probeTokens, PROFILES, (id) => parseVariant(id).baseModelId);
  for (const e of part.excluded) {
    out.write(
      `  ⊘ pre-excluded ${e.id}: effective window ~${Math.round(e.window / 1000)}k < ~${Math.round(e.request / 1000)}k request\n`,
    );
  }
  const candidates = part.fit;
  if (candidates.length === 0) {
    out.write(`No candidate fits the probe (~${Math.round(probeTokens / 1000)}k tok). Use a smaller probe.\n`);
    return;
  }

  const artifact = await runCalibration({
    candidates,
    profiles: PROFILES,
    compactor: makeCompactor(groundTruth),
    reviewer,
    reviewerPool: cfg.reviewerPool,
    reviewersPerBrief: cfg.reviewersPerBrief,
    reviewerEffort: cfg.reviewerEffort,
    concurrency: cfg.concurrency,
    date,
    groundTruth,
    probe,
    exactSpans,
    onSkip,
  });

  const info = probeInfo(cfg.probe === "large" ? "large" : "standard", probe ?? loadProbeContext(), cfg.probe === "large" ? cfg.probeTokens ?? 800_000 : undefined);
  const preExcluded = part.excluded.map((e) => ({ id: e.id, window: e.window, request: e.request }));
  const path = persistArtifact(RESULTS_DIR, { ...artifact, probeInfo: [info], preExcluded, provenance }, suffix);
  out.write(`\nWrote versioned artifact: ${path}\n`);
  out.write(`Scored variants: ${artifact.models.length}/${candidates.length} (skipped ${skips.length})\n\n`);
  out.write(`Per (model × effort):\n`);
  for (const m of [...artifact.models].sort((a, b) => b.fidelityScore - a.fidelityScore)) {
    out.write(
      `  ${m.modelId.padEnd(30)} fidelity=${m.fidelityScore.toFixed(3)} ` +
        `verbosity=${m.verbosityCoeff.toFixed(2)} confidence=${m.confidence.toFixed(2)} ` +
        `tokens=${m.outputTokens} reviewers=${m.reviewers.length}${m.highSpreadWarning ? " ⚠high-spread" : ""}\n`,
    );
  }
  const best = bestPerBaseModel(artifact.models);
  out.write(`\nBest per base model (→ would calibrate):\n`);
  for (const [base, m] of best) {
    out.write(`  ${base.padEnd(28)} effort=${parseVariant(m.modelId).effort} fidelity=${m.fidelityScore.toFixed(3)}\n`);
  }
  for (const note of artifact.notes) out.write(`${note}\n`);
  out.write(`\nFloor proposal: ${artifact.floorProposal ?? "n/a"}. Profile-Flip + Floor erst nach Sichtung (manuell).\n`);
  writeCallSummary(out, cfg, calls);
}

main().catch((err) => {
  process.stderr.write(`calibrate: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
