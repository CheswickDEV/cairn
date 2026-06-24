import { describe, it, expect, vi } from "vitest";
import { runHandoff } from "./handoff.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { loadConfig } from "../core/config.js";
import { EgressNotConfiguredError, type ModelCaller } from "../core/providers.js";

function fakeClock(): () => string {
  let n = 0;
  return () => `2026-06-21T00:00:${String(n++).padStart(2, "0")}.000Z`;
}
const store = () => new SqliteStore({ path: ":memory:", now: fakeClock() });
const opus = { modelId: "claude-opus-4-8" };

// Echoes the masked prompt back → after restoreVerbatim the brief equals the source byte-exact.
const echoCaller: ModelCaller = async (req) => ({ text: req.prompt, truncated: false, finishReason: "endTurn" });

describe("handoff — sampling mode (ADR-0006 mode 2)", () => {
  it("produces the brief via the client sampler, round-trips verbatim, egress=true", async () => {
    const s = store();
    const config = loadConfig({ CAIRN_ENABLE_MODES: "sampling" });
    const sample = vi.fn(echoCaller);
    const r = await runHandoff(
      {
        brief: "",
        source: "Decision: keep scope `read:logs` exactly.",
        host: opus,
        sourceZone: "yellow",
        mode: "sampling",
        requiredVerbatim: ["read:logs"],
      },
      { store: s, config, sample },
    );
    expect(sample).toHaveBeenCalledTimes(1);
    expect(r.egress).toBe(true);
    expect(r.missingRequired).toEqual([]); // read:logs survived byte-exact through the model path
    expect(s.getDecision(r.storedDecisionId)!.rationale).toContain("read:logs");
  });

  it("is refused when sampling is not enabled; the sampler is never called", async () => {
    const sample = vi.fn();
    await expect(
      runHandoff(
        { brief: "x", host: opus, sourceZone: "green", mode: "sampling" },
        { store: store(), config: loadConfig({}), sample: sample as unknown as ModelCaller },
      ),
    ).rejects.toBeInstanceOf(EgressNotConfiguredError);
    expect(sample).not.toHaveBeenCalled();
  });
});

describe("handoff — bridge mode (ADR-0006 mode 3)", () => {
  it("produces the brief via the sibling-CLI caller when enabled + CAIRN_BRIDGE set", async () => {
    const s = store();
    const config = loadConfig({ CAIRN_ENABLE_MODES: "bridge", CAIRN_BRIDGE: "codex" });
    const bridge = vi.fn(echoCaller);
    const r = await runHandoff(
      { brief: "", source: "keep `read:logs`", host: opus, sourceZone: "red", mode: "bridge", requiredVerbatim: ["read:logs"] },
      { store: s, config, bridge },
    );
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(r.egress).toBe(true);
    expect(r.missingRequired).toEqual([]);
  });

  it("is refused when bridge is not enabled; no CLI is invoked", async () => {
    const bridge = vi.fn();
    await expect(
      runHandoff(
        { brief: "x", host: opus, sourceZone: "green", mode: "bridge" },
        { store: store(), config: loadConfig({}), bridge: bridge as unknown as ModelCaller },
      ),
    ).rejects.toBeInstanceOf(EgressNotConfiguredError);
    expect(bridge).not.toHaveBeenCalled();
  });

  it("is refused when bridge is enabled but CAIRN_BRIDGE names no CLI", async () => {
    const bridge = vi.fn();
    await expect(
      runHandoff(
        { brief: "x", host: opus, sourceZone: "green", mode: "bridge" },
        { store: store(), config: loadConfig({ CAIRN_ENABLE_MODES: "bridge" }), bridge: bridge as unknown as ModelCaller },
      ),
    ).rejects.toBeInstanceOf(EgressNotConfiguredError);
    expect(bridge).not.toHaveBeenCalled();
  });
});
