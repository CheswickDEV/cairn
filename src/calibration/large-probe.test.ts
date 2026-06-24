import { describe, it, expect } from "vitest";
import { buildLargeProbe, LARGE_GROUND_TRUTH } from "./large-probe.js";
import { estimateTokens } from "./runner.js";

describe("large-probe generator", () => {
  it("is deterministic (same target → byte-identical probe)", () => {
    expect(buildLargeProbe(5_000).probe).toBe(buildLargeProbe(5_000).probe);
  });

  it("hits ~the requested token target (default ≈ 800k)", () => {
    const big = estimateTokens(buildLargeProbe().probe);
    expect(big).toBeGreaterThanOrEqual(780_000);
    expect(big).toBeLessThanOrEqual(860_000);
  });

  it("places every verbatim (exact) item byte-exact in the probe", () => {
    const { probe, exactSpans } = buildLargeProbe(5_000);
    expect(exactSpans.length).toBe(6);
    for (const span of exactSpans) expect(probe.includes(span)).toBe(true);
  });

  it("padding is fence-free: only the 3 real core code blocks are fenced", () => {
    const probe = buildLargeProbe(60_000).probe; // lots of padding
    expect((probe.match(/```/g) ?? []).length).toBe(6); // 3 fences × 2 delimiters
  });

  it("contains the scored scenario content but NOT the hallucination traps", () => {
    const { probe } = buildLargeProbe(5_000);
    for (const marker of ["EventStoreDB", "Kafka", "ConcurrencyError", "e7b1d40", "eu-central-1"]) {
      expect(probe).toContain(marker);
    }
    for (const trap of LARGE_GROUND_TRUTH.mustNotAppear) {
      expect(probe.includes(trap)).toBe(false);
    }
  });

  it("ground-truth has the expected shape (~25 must_survive, supersession + buried + primacy)", () => {
    expect(LARGE_GROUND_TRUTH.mustSurvive.length).toBeGreaterThanOrEqual(24);
    expect(LARGE_GROUND_TRUTH.mustNotAppear.length).toBe(8);
    expect(LARGE_GROUND_TRUTH.mustSurvive.some((i) => i.primacy)).toBe(true);
    expect(LARGE_GROUND_TRUTH.mustSurvive.some((i) => i.buried)).toBe(true);
    expect(LARGE_GROUND_TRUTH.mustSurvive.some((i) => i.status === "superseded")).toBe(true);
    expect(LARGE_GROUND_TRUTH.mustSurvive.filter((i) => i.exact).length).toBe(6);
  });
});
