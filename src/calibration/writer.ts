/**
 * Cairn - calibration writer (ADR-0005, calibration-spec §5).
 *
 * `applyCalibration` returns an updated profile set (pure): models in the run become
 * `calibrated:true` with measured scores + date + confidence; models NOT in the run keep
 * their provisional/uncalibrated state. `persistArtifact` writes a versioned JSON result so
 * old scores stay around. The source profiles file is NOT auto-rewritten (floor needs manual
 * confirmation per the spec).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelProfile } from "../core/model-profiles.js";
import type { CalibrationArtifact, ModelCalibration } from "./score.js";

/** Pick the winning variant per base model: highest fidelity, tie-break lower verbosity (ADR-0002). */
export function bestPerBaseModel(models: ModelCalibration[]): Map<string, ModelCalibration> {
  const best = new Map<string, ModelCalibration>();
  for (const m of models) {
    const cur = best.get(m.baseModelId);
    const wins =
      !cur ||
      m.fidelityScore > cur.fidelityScore ||
      (m.fidelityScore === cur.fidelityScore && m.verbosityCoeff < cur.verbosityCoeff);
    if (wins) best.set(m.baseModelId, m);
  }
  return best;
}

export function applyCalibration(profiles: ModelProfile[], artifact: CalibrationArtifact): ModelProfile[] {
  const best = bestPerBaseModel(artifact.models);
  return profiles.map((p) => {
    const m = best.get(p.id);
    if (!m) return p; // not in this run → stays provisional / uncalibrated
    return {
      ...p,
      summarizer: {
        ...p.summarizer,
        fidelityScore: m.fidelityScore,
        verbosityCoeff: m.verbosityCoeff,
        calibrated: true,
        calibrationDate: artifact.date,
        confidence: m.confidence,
        effort: m.effort || undefined,
      },
    };
  });
}

/**
 * Write the versioned artifact to `<dir>/<date><nameSuffix>.json` and return the path. It never
 * overwrites: if the name is taken (offline and live runs used to share `<date>.json`), it writes
 * `<date><nameSuffix>-2.json`, `-3`, … instead, so a paid run is neither lost nor replaced.
 */
export function persistArtifact<T extends { date: string }>(dir: string, artifact: T, nameSuffix = ""): string {
  mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(artifact, null, 2) + "\n";
  for (let n = 1; ; n++) {
    const path = join(dir, `${artifact.date}${nameSuffix}${n === 1 ? "" : `-${n}`}.json`);
    try {
      writeFileSync(path, body, { encoding: "utf8", flag: "wx" }); // wx: fail instead of overwrite
      return path;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}
