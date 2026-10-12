import { describe, it, expect, vi } from "vitest";
import { runHandoff, type HandoffDeps } from "./handoff.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { loadConfig } from "../core/config.js";
import type { ModelCaller } from "../core/providers.js";

/* ADR-0012 stage 3: opt-in automatic compaction in account mode (CAIRN_ACCOUNT_SUMMARIZER=auto). */

const TRANSCRIPT = "USER: keep `TZ=UTC` and ```\nexport ORT_DISABLE_CUDA=1\n```\n\nASSISTANT: noted";

/** A caller that writes a brief keeping only the first verbatim marker of the masked transcript. */
const briefCaller = () =>
  vi.fn<ModelCaller>(async (req) => {
    const marker = req.prompt.match(/\[\[CAIRN-HOLD-\d+\]\]/)?.[0] ?? "";
    return { text: `1) DECISIONS\n- TZ ${marker}`, truncated: false, finishReason: "end_turn" };
  });

function deps(opts: { auto?: boolean; transcript?: string | undefined; claude?: ModelCaller; codex?: ModelCaller } = {}) {
  const store = new SqliteStore({ path: ":memory:" });
  const d: HandoffDeps = {
    store,
    config: loadConfig(opts.auto === false ? {} : { CAIRN_ACCOUNT_SUMMARIZER: "auto" }),
    accountAuto: {
      transcript: () => ("transcript" in opts ? opts.transcript : TRANSCRIPT),
      callers: { claude: opts.claude, codex: opts.codex },
    },
  };
  return { d, store };
}

const save = (d: HandoffDeps, modelId: string) =>
  runHandoff({ brief: "HOST BRIEF", host: { modelId }, sourceZone: "red" }, d);

describe("automatic compaction in account mode (opt-in)", () => {
  it("compacts the session transcript with the selected summarizer instead of recommending it", async () => {
    const claude = briefCaller();
    const { d, store } = deps({ claude });
    const r = await save(d, "claude-sonnet-5-5");
    expect(claude).toHaveBeenCalledTimes(1);
    const req = claude.mock.calls[0][0];
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.effort).toBe("high");
    expect(req.prompt).not.toContain("ORT_DISABLE_CUDA"); // verbatim spans travel masked
    expect(r).toMatchObject({ autoCompacted: true, compactedWith: "claude-opus-5-5", egress: true, mode: "account" });
    expect(r.recommendedModel).toBeUndefined();
    expect(store.getDecision(r.storedDecisionId)?.rationale).toBe("1) DECISIONS\n- TZ `TZ=UTC`");
    // Two spans were frozen in the transcript; only the one the brief kept is reported and stored as evidence.
    expect(r.verbatimHolds).toBe(1);
    expect(r.evidenceStored).toBe(1);
  });

  it("a Codex host uses the codex CLI and GPT-6.1 Sol", async () => {
    const codex = briefCaller();
    const r = await save(deps({ codex }).d, "gpt-6-luna");
    expect(codex.mock.calls[0][0].model).toBe("gpt-6.1-sol");
    expect(r.compactedWith).toBe("gpt-6.1-sol");
  });

  it("makes no call when it is off, or when the host already is the selected summarizer", async () => {
    const claude = briefCaller();
    const off = await save(deps({ auto: false, claude }).d, "claude-sonnet-5-5");
    expect(off).toMatchObject({ recommendedModel: "claude-opus-5-5", egress: false });
    expect(off.autoSkipped).toBeUndefined();
    const same = await save(deps({ claude }).d, "claude-opus-5-5");
    expect(same.recommendedModel).toBeUndefined();
    expect(claude).not.toHaveBeenCalled();
  });

  it.each([
    ["no transcript", { transcript: undefined }, /no claude session transcript found/],
    ["no caller for the CLI", { claude: undefined }, /no claude caller/],
    ["a failing CLI", { claude: vi.fn<ModelCaller>(async () => { throw new Error("claude not logged in"); }) }, /claude call failed: claude not logged in/],
    ["an error result", { claude: vi.fn<ModelCaller>(async () => ({ text: "API Error", truncated: false, finishReason: "error" })) }, /gave no complete brief \(error\)/],
    ["a truncated answer", { claude: vi.fn<ModelCaller>(async () => ({ text: "1) DEC", truncated: true, finishReason: "max_tokens" })) }, /gave no complete brief/],
    ["an empty answer", { claude: vi.fn<ModelCaller>(async () => ({ text: " ", truncated: false, finishReason: "end_turn" })) }, /gave no complete brief/],
  ] as const)("%s → the host's brief stays, with the reason and the recommendation", async (_, opts, reason) => {
    const { d, store } = deps({ claude: briefCaller(), ...opts });
    const r = await save(d, "claude-sonnet-5-5");
    expect(r.autoCompacted).toBeUndefined();
    expect(r.autoSkipped).toMatch(reason);
    expect(r.recommendedModel).toBe("claude-opus-5-5");
    expect(r.egress).toBe(false);
    expect(store.getDecision(r.storedDecisionId)?.rationale).toBe("HOST BRIEF");
  });

  it("skips a transcript too large for the model's window without calling it", async () => {
    const codex = briefCaller();
    // GPT-6.1 Sol via Codex: 258,400 tokens; at ~4 chars/token and 1.7× request inflation ~608K chars fit.
    const r = await save(deps({ codex, transcript: "x".repeat(700_000) }).d, "gpt-6-luna");
    expect(codex).not.toHaveBeenCalled();
    expect(r.autoSkipped).toMatch(/does not fit gpt-6\.1-sol's window/);
  });
});
