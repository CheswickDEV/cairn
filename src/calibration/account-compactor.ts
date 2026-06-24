/**
 * Cairn - real account-session compactor (ADR-0005/0006). Each candidate variant compacts the
 * probe on its OWN subscription via the bridge, at the variant's reasoning effort. Injectable
 * `execFn` keeps it unit-testable; the real run uses the default spawn.
 */

import { bridgeCompact, type ExecFn } from "../core/bridge.js";
import { PROFILES } from "../core/model-profiles.js";
import { estimateTokens, type Compactor } from "./runner.js";
import { parseVariant, cliFor, cliModelName, type CalibEcosystem } from "./variants.js";

export interface AccountCompactorOptions {
  execFn?: ExecFn;
  timeoutMs?: number;
  maxTokens?: number;
  /** Briefs below this many tokens are treated as a failure (model unavailable/refused → skip). */
  minBriefTokens?: number;
}

export function makeAccountCompactor(opts: AccountCompactorOptions = {}): Compactor {
  return async ({ modelId, maskedProbe, prompt }) => {
    const { baseModelId, effort } = parseVariant(modelId);
    const profile = PROFILES.find((p) => p.id === baseModelId);
    if (!profile || (profile.ecosystem !== "anthropic" && profile.ecosystem !== "openai")) {
      throw new Error(`variant '${modelId}': no bridgeable ecosystem`);
    }
    const ecosystem = profile.ecosystem as CalibEcosystem;
    const result = await bridgeCompact({
      cli: cliFor(ecosystem),
      effort,
      request: {
        systemPrompt: prompt, // the 7-bucket prompt
        prompt: maskedProbe, // verbatim-masked probe on stdin
        maxTokens: opts.maxTokens ?? 4096,
        model: cliModelName(baseModelId, ecosystem),
      },
      execFn: opts.execFn,
      timeoutMs: opts.timeoutMs,
    });
    const outputTokens = estimateTokens(result.text);
    // Accurate label when the probe exceeded the model's window (ADR-0003) vs a generic short stub.
    if (/prompt is too long|too long|context (window|length)|exceeds.*(context|window|token)/i.test(result.text)) {
      throw new Error(`context exceeds window — '${modelId}' rejected the probe: ${result.text.slice(0, 90)}`);
    }
    // Sanity gate: a real 7-bucket brief is hundreds of tokens. A tiny output means the model was
    // unavailable/refused (e.g. a codex "model not available" stub) - skip it so it pollutes
    // neither the candidate scores nor the reviewer pool.
    const min = opts.minBriefTokens ?? 120;
    if (outputTokens < min) {
      throw new Error(`brief too short (${outputTokens} tok < ${min}) — '${modelId}' likely unavailable/refused`);
    }
    return { brief: result.text, outputTokens };
  };
}
