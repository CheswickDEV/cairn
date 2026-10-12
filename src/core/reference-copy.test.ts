import { describe, it, expect } from "vitest";
import { PROFILES, selectSummarizer, type ModelProfile, type Zone } from "./model-profiles.js";

/* docs/reference/model-profiles.ts mirrors the profile data and the selection rule. It is not part of the
   typecheck program (it gets its own strict check), so it is loaded by a non-literal path here. */
const REF = "../../docs/reference/model-profiles.ts";
const ref = await import(/* @vite-ignore */ REF);

describe("docs/reference/model-profiles.ts matches src", () => {
  it("carries the same profiles", () => {
    expect(ref.PROFILES).toEqual(PROFILES);
  });

  it("selects the same summarizer for every host, zone, floor and reachability", async () => {
    const hosts = [
      { modelId: "claude-opus-5-5" },
      { modelId: "claude-haiku-5-5" },
      { modelId: "claude-opus-4-8" },
      { provider: "openai", modelId: "gpt-6.1-sol" },
      { modelId: "gpt-6-luna" },
      { modelId: "gpt-5.5" },
      { modelId: "totally-unknown" },
      { modelId: "anthropic.claude-opus-5-5" },
      { modelId: "us.anthropic.claude-sonnet-5-5[1m]" },
      { modelId: "openai/gpt-6.1-sol@high" },
    ];
    const reach: ((p: ModelProfile) => Promise<boolean>)[] = [
      async (p) => p.status === "active",
      async () => true,
      async (p) => p.status === "active" && p.id !== "claude-opus-5-5" && p.id !== "gpt-6.1-sol",
    ];
    for (const host of hosts) {
      for (const sourceZone of ["green", "yellow", "red"] as Zone[]) {
        for (const fidelityFloor of [0, 0.84, 0.95]) {
          for (const reachable of reach) {
            const input = { host, sourceZone, fidelityFloor, reachable, cost: { inputTokens: 180_000, expectedBriefTokens: 6_000 } };
            const a = await selectSummarizer(input);
            const b = await ref.selectSummarizer(input);
            expect(b.kind).toBe(a.kind);
            expect(b.reason).toBe(a.reason);
            expect(b.kind === "model" ? b.model.id : null).toBe(a.kind === "model" ? a.model.id : null);
          }
        }
      }
    }
  });
});
