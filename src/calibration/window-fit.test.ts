import { describe, it, expect } from "vitest";
import { estimateRequestTokens, probeFitsModel, partitionByWindow, REQUEST_INFLATION } from "./window-fit.js";
import { parseVariant } from "./variants.js";
import { PROFILES } from "../core/model-profiles.js";

describe("window-fit (ADR-0003/0004)", () => {
  it("inflates the probe into a request (~1.7×)", () => {
    expect(estimateRequestTokens(400_000)).toBe(Math.round(400_000 * REQUEST_INFLATION));
  });

  it("matches the observed 2026-06-22 bridge reality", () => {
    // opus (1M) took 400k (~0.68M) but rejected 800k (~1.36M).
    expect(probeFitsModel("claude-opus-4-8", 400_000)).toBe(true);
    expect(probeFitsModel("claude-opus-4-8", 800_000)).toBe(false);
    // sonnet & haiku (effective ~200k) reject a 400k probe but take a small one.
    expect(probeFitsModel("claude-sonnet-4-6", 400_000)).toBe(false);
    expect(probeFitsModel("claude-haiku-4-5-20251001", 400_000)).toBe(false);
    expect(probeFitsModel("claude-haiku-4-5-20251001", 100_000)).toBe(true);
  });

  it("partitions candidate variants by window fit, with reasons", () => {
    const cands = ["claude-opus-4-8@high", "claude-sonnet-4-6@high", "claude-haiku-4-5-20251001@high"];
    const { fit, excluded } = partitionByWindow(cands, 400_000, PROFILES, (id) => parseVariant(id).baseModelId);
    expect(fit).toEqual(["claude-opus-4-8@high"]);
    expect(excluded.map((e) => e.id).sort()).toEqual(["claude-haiku-4-5-20251001@high", "claude-sonnet-4-6@high"]);
    expect(excluded[0].request).toBe(680_000);
  });

  it("a small compact probe fits all models (no exclusions)", () => {
    const cands = ["claude-opus-4-8@high", "claude-sonnet-4-6@high", "claude-haiku-4-5-20251001@high"];
    const { excluded } = partitionByWindow(cands, 6_000, PROFILES, (id) => parseVariant(id).baseModelId);
    expect(excluded).toEqual([]);
  });
});
