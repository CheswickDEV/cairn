import { describe, it, expect } from "vitest";
import { variantId, parseVariant, buildVariants, DEFAULT_EFFORTS } from "./variants.js";
import { mapWithConcurrency } from "./concurrency.js";
import { PROFILES } from "../core/model-profiles.js";

describe("variants", () => {
  it("encodes/parses modelId@effort round-trip (model ids may contain dashes/dots)", () => {
    expect(variantId("claude-opus-4-8", "xhigh")).toBe("claude-opus-4-8@xhigh");
    expect(parseVariant("claude-opus-4-8@xhigh")).toEqual({ baseModelId: "claude-opus-4-8", effort: "xhigh" });
    expect(parseVariant("gpt-5.5@high")).toEqual({ baseModelId: "gpt-5.5", effort: "high" });
  });

  it("builds (active anthropic+openai × effort) variants, cross-ecosystem", () => {
    const v = buildVariants();
    const anthropic = PROFILES.filter((p) => p.status === "active" && p.ecosystem === "anthropic").length;
    const openai = PROFILES.filter((p) => p.status === "active" && p.ecosystem === "openai").length;
    expect(v.length).toBe(anthropic * DEFAULT_EFFORTS.anthropic.length + openai * DEFAULT_EFFORTS.openai.length);
    // Fable is suspended → excluded; ollama/generic are not anthropic/openai → excluded.
    expect(v.some((x) => x.baseModelId === "claude-fable-5")).toBe(false);
    expect(v.some((x) => x.baseModelId === "ollama:local")).toBe(false);
    expect(v.every((x) => x.ecosystem === "anthropic" || x.ecosystem === "openai")).toBe(true);
  });

  it("respects an ecosystem filter and custom efforts", () => {
    const v = buildVariants({ ecosystems: ["anthropic"], efforts: { anthropic: ["high"] } });
    expect(v.every((x) => x.ecosystem === "anthropic" && x.effort === "high")).toBe(true);
    expect(v.some((x) => x.baseModelId === "claude-opus-4-8")).toBe(true);
  });
});

describe("mapWithConcurrency", () => {
  it("runs all items and preserves order, with bounded parallelism", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
