import { describe, it, expect, vi } from "vitest";
import type { ExecFn } from "../core/bridge.js";
import { productBridge, defaultExec, runBridge, answeringModels, PRODUCT_BRIDGE_EFFORT } from "../core/bridge.js";
import { callAnthropic, callOpenAICompatible, type FetchFn, type ModelCaller } from "../core/providers.js";
import type { CairnConfig } from "../core/config.js";
import { runHandoff, compactionEffort, EFFORT_MAX_TOKENS } from "../tools/handoff.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { makeAccountCompactor } from "./account-compactor.js";
import { makeModelReviewer } from "./model-reviewer.js";
import { DEFAULT_EFFORTS, EFFORT_ORDER, assertMinEffort, assertExactEffort, assertRanModel, buildVariants } from "./variants.js";
import { loadGroundTruth } from "./fixtures.js";

/* ADR-0012: no calibration or bridge call below `high`; reviewers at exactly `high`. */

const GT = loadGroundTruth();
const claudeOk = () => vi.fn<ExecFn>(async () => ({ stdout: JSON.stringify({ result: '1) DECISIONS {"recall":1,"hallucination":1,"supersession":1}' }), stderr: "", code: 0 }));
const codexOk = () =>
  vi.fn<ExecFn>(async () => ({
    stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '1) DECISIONS {"recall":1,"hallucination":1,"supersession":1}' } }),
    stderr: "",
    code: 0,
  }));

describe("effort tiers", () => {
  it("DEFAULT_EFFORTS is `high` only, for both ecosystems", () => {
    expect(DEFAULT_EFFORTS).toEqual({ anthropic: ["high"], openai: ["high"] });
    expect(buildVariants().every((v) => v.effort === "high")).toBe(true);
  });

  it("orders the tiers none … max", () => {
    expect(EFFORT_ORDER).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("assertMinEffort accepts high and above; rejects lower, empty, unknown and mis-cased values", () => {
    for (const e of ["high", "xhigh", "max"]) expect(assertMinEffort(e, "high")).toBe(e);
    for (const e of ["none", "minimal", "low", "medium"]) expect(() => assertMinEffort(e, "high")).toThrow(/below the 'high' minimum/);
    for (const e of ["", "High", "HIGH", "ultra", "ultracode", " high"]) expect(() => assertMinEffort(e, "high")).toThrow(/not one of/);
  });

  it("assertExactEffort accepts only the exact tier", () => {
    expect(assertExactEffort("high", "high")).toBe("high");
    for (const e of ["medium", "xhigh", "max", "High", ""]) expect(() => assertExactEffort(e, "high")).toThrow(/exactly 'high'/);
  });

  it("buildVariants refuses an effort below high", () => {
    expect(() => buildVariants({ efforts: { anthropic: ["medium"] } })).toThrow(/below the 'high' minimum/);
  });
});

describe("account compactor: effort floor before any CLI call", () => {
  it.each(["claude-opus-5-5", "claude-opus-5-5@medium", "claude-opus-5-5@High", "gpt-6.1-sol@low", "gpt-6-luna@"])(
    "%s throws and never calls the CLI",
    async (modelId) => {
      const exec = claudeOk();
      const c = makeAccountCompactor({ execFn: exec, minBriefTokens: 0 });
      await expect(c({ modelId, maskedProbe: "PROBE", prompt: "SYS" })).rejects.toThrow(/effort/);
      expect(exec).not.toHaveBeenCalled();
    },
  );

  it("claude-* @high → `claude --effort high`", async () => {
    const exec = claudeOk();
    await makeAccountCompactor({ execFn: exec, minBriefTokens: 0 })({ modelId: "claude-haiku-5-5@high", maskedProbe: "P", prompt: "S" });
    const [cmd, args] = exec.mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });

  it("gpt-6-* @high → `codex exec -c model_reasoning_effort=high`", async () => {
    const exec = codexOk();
    await makeAccountCompactor({ execFn: exec, minBriefTokens: 0 })({ modelId: "gpt-6-astra@high", maskedProbe: "P", prompt: "S" });
    const [cmd, args] = exec.mock.calls[0];
    expect(cmd).toBe("codex");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-6-astra");
    expect(args[args.indexOf("-c") + 1]).toBe("model_reasoning_effort=high");
  });
});

describe("CLAUDE_CODE_EFFORT_LEVEL cannot override the requested effort", () => {
  // Claude Code: the env var takes precedence over `--effort`, so the bridge pins it to the requested tier.
  it("compactor, reviewer and product bridge set it to `high` for the claude child", async () => {
    const compactor = claudeOk();
    await makeAccountCompactor({ execFn: compactor, minBriefTokens: 0 })({ modelId: "claude-opus-5-5@high", maskedProbe: "P", prompt: "S" });
    const reviewer = claudeOk();
    await makeModelReviewer({ execFn: reviewer })({ authorModelId: "gpt-6-luna@high", reviewerModelId: "claude-fable-5-1", brief: "B", groundTruth: GT });
    const bridge = claudeOk();
    await productBridge("claude", "en", bridge)({ prompt: "x", maxTokens: 100, model: "claude-sonnet-5-5" });
    for (const exec of [compactor, reviewer, bridge]) expect(exec.mock.calls[0][2].env).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: "high" });
  });

  it("bridge calls run without user/plugin hooks (a prompt hook would add a second answering model)", async () => {
    const exec = claudeOk();
    await productBridge("claude", "en", exec)({ prompt: "x", maxTokens: 100, model: "claude-opus-5-5" });
    const args = exec.mock.calls[0][1];
    expect(JSON.parse(args[args.indexOf("--settings") + 1]).disableAllHooks).toBe(true);
  });

  it("pins it via --settings as well (a settings `env` block outranks the shell) and loads user settings only", async () => {
    const exec = claudeOk();
    await runBridge({ cli: "claude", system: "S", user: "U", model: "claude-opus-5-5", effort: "high", execFn: exec });
    const args = exec.mock.calls[0][1];
    expect(JSON.parse(args[args.indexOf("--settings") + 1])).toEqual({ disableAllHooks: true, env: { CLAUDE_CODE_EFFORT_LEVEL: "high" } });
    // project/local settings from the shared tmpdir cwd (hooks, env, caps) are never loaded
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("user");
  });

  it("pins only documented Claude levels; an unknown word is not pinned", async () => {
    const exec = claudeOk();
    await runBridge({ cli: "claude", system: "S", user: "U", effort: "foo", execFn: exec });
    const [, args, opts] = exec.mock.calls[0];
    expect(JSON.parse(args[args.indexOf("--settings") + 1])).toEqual({ disableAllHooks: true }); // no env pin
    expect(opts.env).toBeUndefined();
    const codex = codexOk();
    await runBridge({ cli: "codex", system: "S", user: "U", effort: "high", execFn: codex });
    expect(codex.mock.calls[0][2].env).toBeUndefined();
    expect(codex.mock.calls[0][1]).not.toContain("--settings");
  });

  it("the spawned child sees `high` even when the parent has CLAUDE_CODE_EFFORT_LEVEL=medium", async () => {
    vi.stubEnv("CLAUDE_CODE_EFFORT_LEVEL", "medium");
    try {
      const print = ["-e", "process.stdout.write(process.env.CLAUDE_CODE_EFFORT_LEVEL ?? '')"];
      const pinned = await defaultExec(process.execPath, print, { timeoutMs: 20_000, env: { CLAUDE_CODE_EFFORT_LEVEL: "high" } });
      expect(pinned.stdout).toBe("high");
      const inherited = await defaultExec(process.execPath, print, { timeoutMs: 20_000 });
      expect(inherited.stdout).toBe("medium");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the requested model must be the one that answered (no silent fallback)", () => {
  const answeredBy = (model: string) =>
    vi.fn<ExecFn>(async () => ({
      stdout: JSON.stringify({ result: '1) DECISIONS {"recall":1,"hallucination":1,"supersession":1}', modelUsage: { [model]: { outputTokens: 10 } } }),
      stderr: "",
      code: 0,
    }));

  it("answeringModels keeps only models that produced output (a refused model shows zero output)", () => {
    const refusal = {
      "claude-opus-5-5": { inputTokens: 20, outputTokens: 0, thinkingTokens: 0 },
      "claude-opus-5": { inputTokens: 10, outputTokens: 7, thinkingTokens: 0 },
    };
    expect(answeringModels(refusal)).toEqual(["claude-opus-5"]);
    expect(answeringModels({ "claude-opus-5-5": { outputTokens: 0, thinkingTokens: 12 } })).toEqual(["claude-opus-5-5"]);
    expect(answeringModels({ "claude-opus-5-5": {} })).toEqual(["claude-opus-5-5"]); // no counts → counts as answered
    expect(answeringModels(undefined)).toBeUndefined();
  });

  it("assertRanModel accepts only the requested model (date / provider-version forms), never another one", () => {
    const answered = (...ids: string[]) => ({ modelsUsed: ids, modelsReported: ids });
    for (const ran of ["claude-opus-5-5", "claude-opus-5-5[1m]", "us.anthropic.claude-opus-5-5-v1:0", "claude-opus-5-5-20260922"]) {
      expect(() => assertRanModel(answered(ran), "claude-opus-5-5", "x")).not.toThrow();
    }
    expect(() => assertRanModel(answered("claude-haiku-4-5"), "claude-opus-5-5", "x")).toThrow(/model fallback/);
    expect(() => assertRanModel(answered("claude-opus-5"), "claude-opus-5-5", "x")).toThrow(/model fallback/);
    // a version step is another model, also in the other direction
    expect(() => assertRanModel(answered("claude-opus-5-5"), "claude-opus-5", "x")).toThrow(/model fallback/);
    expect(() => assertRanModel(answered("claude-fable-5-1"), "claude-fable-5", "x")).toThrow(/model fallback/);
    // the requested model plus a fallback that also produced output: still rejected
    expect(() => assertRanModel(answered("claude-opus-5-5", "claude-opus-4-8"), "claude-opus-5-5", "x")).toThrow(/model fallback/);
    // a listed model without output (e.g. after a refusal) does not count when the requested one answered
    expect(() => assertRanModel({ modelsUsed: ["claude-opus-5-5"], modelsReported: ["claude-opus-5-5", "claude-haiku-5-5"] }, "claude-opus-5-5", "x")).not.toThrow();
    // no usage reported (codex) → nothing to check
    expect(() => assertRanModel({}, "claude-opus-5-5", "x")).not.toThrow();
  });

  it("no output reported at all (a gateway without usage): the listed models decide", () => {
    const noUsage = (...ids: string[]) => ({ modelsUsed: [], modelsReported: ids });
    expect(() => assertRanModel(noUsage("claude-opus-5-5"), "claude-opus-5-5", "x")).not.toThrow();
    // refusal switch without usage: the fallback model is listed
    expect(() => assertRanModel(noUsage("claude-opus-5-5", "claude-opus-4-8"), "claude-opus-5-5", "x")).toThrow(/model fallback/);
    // fallbackModel chain without usage: the requested model is missing
    expect(() => assertRanModel(noUsage("claude-sonnet-5-5"), "claude-opus-5-5", "x")).toThrow(/model fallback/);
    // nothing listed (an API error, caught by assertNotError) is no fallback evidence
    expect(() => assertRanModel(noUsage(), "claude-opus-5-5", "x")).not.toThrow();
  });

  it("verbose JSON (an array of events) is read from its `result` event", async () => {
    const events = [
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success", is_error: true, result: "API Error: overloaded", modelUsage: { "claude-opus-5-5": { outputTokens: 0 } } },
    ];
    const exec = vi.fn<ExecFn>(async () => ({ stdout: JSON.stringify(events), stderr: "", code: 1 }));
    const r = await runBridge({ cli: "claude", system: "S", user: "U", model: "claude-opus-5-5", effort: "high", execFn: exec });
    expect(r).toMatchObject({ text: "API Error: overloaded", finishReason: "error", modelsReported: ["claude-opus-5-5"], modelsUsed: [] });
  });

  it("a codex error event or non-zero exit is an error result, not an answer", async () => {
    const errorText = "unexpected status 400 Bad Request: " + "x".repeat(600);
    const codexError = vi.fn<ExecFn>(async () => ({
      stdout: [JSON.stringify({ type: "thread.started" }), JSON.stringify({ type: "error", message: errorText })].join("\n"),
      stderr: "",
      code: 1,
    }));
    // The error message is never taken as the answer: no text + exit 1 → the bridge call fails outright,
    // with codex's own error message (stdout only) as the reason.
    await expect(runBridge({ cli: "codex", system: "S", user: "U", model: "gpt-6-astra", effort: "high", execFn: codexError })).rejects.toThrow(/codex bridge failed \(code 1\): unexpected status 400/);
    // the same without a non-zero exit: an error event that no turn.completed follows also fails the call
    const errorExit0 = vi.fn<ExecFn>(async () => ({ stdout: JSON.stringify({ type: "error", message: "Codex ran out of room in the model's context window" }), stderr: "", code: 0 }));
    await expect(runBridge({ cli: "codex", system: "S", user: "U", execFn: errorExit0 })).rejects.toThrow(/ran out of room/);
    const turnFailed = vi.fn<ExecFn>(async () => ({ stdout: JSON.stringify({ type: "turn.failed", error: { message: "quota exceeded" } }), stderr: "Reading prompt from stdin...", code: 1 }));
    await expect(runBridge({ cli: "codex", system: "S", user: "U", execFn: turnFailed })).rejects.toThrow(/quota exceeded/);
    const c = makeAccountCompactor({ execFn: codexError });
    await expect(c({ modelId: "gpt-6-astra@high", maskedProbe: "P", prompt: "S" })).rejects.toThrow(/codex bridge failed/);
    // an answer text with a non-zero exit is an error result
    const textExit1 = vi.fn<ExecFn>(async () => ({
      stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "1) DECISIONS " + "x".repeat(800) } }),
      stderr: "",
      code: 1,
    }));
    expect((await runBridge({ cli: "codex", system: "S", user: "U", execFn: textExit1 })).finishReason).toBe("error");
    await expect(makeAccountCompactor({ execFn: textExit1 })({ modelId: "gpt-6-astra@high", maskedProbe: "P", prompt: "S" })).rejects.toThrow(/error result/);
    const failedTurn = vi.fn<ExecFn>(async () => ({
      stdout: [JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "partial" } }), JSON.stringify({ type: "turn.failed", error: { message: "boom" } })].join("\n"),
      stderr: "",
      code: 0,
    }));
    expect((await runBridge({ cli: "codex", system: "S", user: "U", execFn: failedTurn })).finishReason).toBe("error");
    expect((await runBridge({ cli: "codex", system: "S", user: "U", execFn: codexOk() })).finishReason).toBe("stop");
  });

  it("a retried codex stream error followed by turn.completed is not a failure", async () => {
    const brief = "1) DECISIONS " + "d".repeat(800);
    const retried = vi.fn<ExecFn>(async () => ({
      stdout: [
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: "error", message: "stream disconnected - retrying" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: brief } }),
        JSON.stringify({ type: "turn.completed", usage: {} }),
      ].join("\n"),
      stderr: "",
      code: 0,
    }));
    expect((await runBridge({ cli: "codex", system: "S", user: "U", execFn: retried })).finishReason).toBe("stop");
    const c = makeAccountCompactor({ execFn: retried });
    await expect(c({ modelId: "gpt-6.1-sol@high", maskedProbe: "P", prompt: "S" })).resolves.toMatchObject({ brief });
  });

  it("a retried stream error without a final agent message yields no text (the error is never the answer)", async () => {
    const longError = "Reconnecting... 2/5 (unexpected status 502: " + "<html>".repeat(150) + ")";
    const noMessage = vi.fn<ExecFn>(async () => ({
      stdout: [JSON.stringify({ type: "error", message: longError }), JSON.stringify({ type: "turn.completed", usage: {} })].join("\n"),
      stderr: "",
      code: 0,
    }));
    const r = await runBridge({ cli: "codex", system: "S", user: "U", execFn: noMessage });
    expect(r.text).toBe("");
    await expect(makeAccountCompactor({ execFn: noMessage })({ modelId: "gpt-6-luna@high", maskedProbe: "P", prompt: "S" })).rejects.toThrow(/too short/);
  });

  it("a codex safeguard reroute is reported and the calibration skips it", async () => {
    const brief = "1) DECISIONS " + "r".repeat(800);
    const rerouted = vi.fn<ExecFn>(async () => ({
      stdout: [
        JSON.stringify({ type: "item.completed", item: { id: "i0", type: "error", message: "model rerouted: gpt-6-astra -> gpt-6.1-sol (HighRiskCyberActivity)" } }),
        JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: brief } }),
        JSON.stringify({ type: "turn.completed", usage: {} }),
      ].join("\n"),
      stderr: "",
      code: 0,
    }));
    const r = await runBridge({ cli: "codex", system: "S", user: "U", model: "gpt-6-astra", execFn: rerouted });
    expect(r).toMatchObject({ text: brief, finishReason: "stop", modelsUsed: ["gpt-6.1-sol"], modelsReported: ["gpt-6-astra", "gpt-6.1-sol"] });
    await expect(makeAccountCompactor({ execFn: rerouted })({ modelId: "gpt-6-astra@high", maskedProbe: "P", prompt: "S" })).rejects.toThrow(/model fallback/);
    // a plain codex warning item does not count as a reroute
    const warning = vi.fn<ExecFn>(async () => ({
      stdout: [JSON.stringify({ type: "item.completed", item: { type: "error", message: "some warning" } }), JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: brief } })].join("\n"),
      stderr: "",
      code: 0,
    }));
    await expect(makeAccountCompactor({ execFn: warning })({ modelId: "gpt-6-astra@high", maskedProbe: "P", prompt: "S" })).resolves.toMatchObject({ brief });
  });

  it("claude JSON with a non-zero exit is an error result even without is_error", async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: JSON.stringify({ result: "x".repeat(800), subtype: "success", is_error: false }), stderr: "", code: 1 }));
    expect((await runBridge({ cli: "claude", system: "S", user: "U", execFn: exec })).finishReason).toBe("error");
  });

  it("claude non-JSON output with a non-zero exit is an error result", async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: "Error: something went wrong " + "x".repeat(600), stderr: "", code: 2 }));
    expect((await runBridge({ cli: "claude", system: "S", user: "U", execFn: exec })).finishReason).toBe("error");
  });

  it("a valid brief that mentions a context window is not mistaken for a window error", async () => {
    const brief = "1) DECISIONS keep the context window at 1M; the old prompt was too long. " + "b".repeat(600);
    const exec = vi.fn<ExecFn>(async () => ({ stdout: JSON.stringify({ result: brief, subtype: "success", modelUsage: { "claude-opus-5-5": { outputTokens: 300 } } }), stderr: "", code: 0 }));
    const c = makeAccountCompactor({ execFn: exec });
    await expect(c({ modelId: "claude-opus-5-5@high", maskedProbe: "P", prompt: "S" })).resolves.toMatchObject({ brief });
    const tooLong = vi.fn<ExecFn>(async () => ({ stdout: JSON.stringify({ result: "Prompt is too long", is_error: true, subtype: "success", modelUsage: {} }), stderr: "", code: 1 }));
    await expect(makeAccountCompactor({ execFn: tooLong })({ modelId: "claude-opus-5-5@high", maskedProbe: "P", prompt: "S" })).rejects.toThrow(/context exceeds window/);
  });

  it("a refusal fallback (requested model with zero output) is skipped for compaction and review", async () => {
    const exec = vi.fn<ExecFn>(async () => ({
      stdout: JSON.stringify({
        result: '1) DECISIONS {"recall":1,"hallucination":1,"supersession":1}',
        modelUsage: { "claude-opus-5-5": { outputTokens: 0, thinkingTokens: 0 }, "claude-opus-5": { outputTokens: 7, thinkingTokens: 0 } },
      }),
      stderr: "",
      code: 0,
    }));
    const c = makeAccountCompactor({ execFn: exec, minBriefTokens: 0 });
    await expect(c({ modelId: "claude-opus-5-5@high", maskedProbe: "P", prompt: "S" })).rejects.toThrow(/answered by claude-opus-5/);
    const r = makeModelReviewer({ execFn: exec });
    await expect(r({ authorModelId: "gpt-6-luna@high", reviewerModelId: "claude-opus-5-5", brief: "B", groundTruth: GT })).rejects.toThrow(/model fallback/);
  });

  it("an error result (is_error, e.g. a refusal mid-stream without fallback) is skipped even when long", async () => {
    const errorText = "API Error: the model's safeguards flagged this request. " + "x".repeat(600);
    const exec = vi.fn<ExecFn>(async () => ({
      stdout: JSON.stringify({ result: errorText, subtype: "success", is_error: true, modelUsage: { "claude-sonnet-5-5": { outputTokens: 12, thinkingTokens: 0 } } }),
      stderr: "",
      code: 1,
    }));
    const r = await runBridge({ cli: "claude", system: "S", user: "U", model: "claude-sonnet-5-5", effort: "high", execFn: exec });
    expect(r.finishReason).toBe("error"); // is_error wins over subtype "success"
    const c = makeAccountCompactor({ execFn: exec }); // default 120-token gate would let this text through
    await expect(c({ modelId: "claude-sonnet-5-5@high", maskedProbe: "P", prompt: "S" })).rejects.toThrow(/error result/);
    const rev = makeModelReviewer({ execFn: exec });
    await expect(rev({ authorModelId: "gpt-6-luna@high", reviewerModelId: "claude-sonnet-5-5", brief: "B", groundTruth: GT })).rejects.toThrow(/error result/);
  });

  it("a compaction answered by a fallback model is skipped, not credited to the requested id", async () => {
    const c = makeAccountCompactor({ execFn: answeredBy("claude-haiku-4-5"), minBriefTokens: 0 });
    await expect(c({ modelId: "claude-opus-5-5@high", maskedProbe: "P", prompt: "S" })).rejects.toThrow(/not only 'claude-opus-5-5'/);
    const ok = makeAccountCompactor({ execFn: answeredBy("claude-opus-5-5"), minBriefTokens: 0 });
    await expect(ok({ modelId: "claude-opus-5-5@high", maskedProbe: "P", prompt: "S" })).resolves.toBeTruthy();
  });

  it("a review answered by a fallback model is skipped", async () => {
    const r = makeModelReviewer({ execFn: answeredBy("claude-haiku-4-5") });
    await expect(r({ authorModelId: "gpt-6-luna@high", reviewerModelId: "claude-sonnet-5-5", brief: "B", groundTruth: GT })).rejects.toThrow(/model fallback/);
  });
});

describe("model reviewer: exactly `high`, checked at creation", () => {
  it.each(["medium", "xhigh", "High", ""])("effort %j throws when the reviewer is created", (effort) => {
    expect(() => makeModelReviewer({ effort, execFn: claudeOk() })).toThrow(/exactly 'high'/);
  });

  it("default and explicit `high` run the reviewer CLI at high (claude and codex)", async () => {
    const claude = claudeOk();
    await makeModelReviewer({ execFn: claude })({ authorModelId: "gpt-6-luna@high", reviewerModelId: "claude-sonnet-5-5", brief: "B", groundTruth: GT });
    expect(claude.mock.calls[0][1]).toEqual(expect.arrayContaining(["--effort", "high"]));
    const codex = codexOk();
    await makeModelReviewer({ execFn: codex, effort: "high" })({ authorModelId: "claude-opus-5-5@high", reviewerModelId: "gpt-6.1-sol", brief: "B", groundTruth: GT });
    expect(codex.mock.calls[0][1]).toContain("model_reasoning_effort=high");
  });
});

describe("product paths", () => {
  it("the product bridge (CAIRN_BRIDGE) always passes effort high", async () => {
    expect(PRODUCT_BRIDGE_EFFORT).toBe("high");
    const claude = claudeOk();
    await productBridge("claude", "en", claude)({ prompt: "x", maxTokens: 100, model: "claude-opus-5-5" });
    expect(claude.mock.calls[0][1]).toEqual(expect.arrayContaining(["--effort", "high"]));
    const codex = codexOk();
    await productBridge("codex", "en", codex)({ prompt: "x", maxTokens: 100, model: "gpt-6.1-sol" });
    expect(codex.mock.calls[0][1]).toContain("model_reasoning_effort=high");
  });

  it("API adapters send the documented effort fields only when set", async () => {
    const ep = { provider: "anthropic" as const, baseUrl: "https://api.example.test" };
    const body = (f: ReturnType<typeof vi.fn>) => JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    const anth = vi.fn(async () => ({ json: async () => ({ content: [{ type: "text", text: "x" }], stop_reason: "end_turn" }) }));
    await callAnthropic(ep, { prompt: "p", maxTokens: 10, model: "claude-opus-5-5", effort: "high" }, anth as unknown as FetchFn, {});
    expect(body(anth).output_config).toEqual({ effort: "high" });
    const oai = vi.fn(async () => ({ json: async () => ({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }) }));
    await callOpenAICompatible({ ...ep, provider: "openai" }, { prompt: "p", maxTokens: 10, model: "gpt-6.1-sol", effort: "high" }, oai as unknown as FetchFn, {});
    expect(body(oai).reasoning_effort).toBe("high");
    const plain = vi.fn(async () => ({ json: async () => ({ content: [], stop_reason: "end_turn" }) }));
    await callAnthropic(ep, { prompt: "p", maxTokens: 10, model: "m" }, plain as unknown as FetchFn, {});
    expect(body(plain)).not.toHaveProperty("output_config");
  });

  it("handoff sets effort high for pool models only (legacy/unknown keep the provider default)", async () => {
    for (const id of ["claude-fable-5-1", "claude-opus-5-5[1m]", "claude-sonnet-5-5", "claude-haiku-5-5", "gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]) {
      expect(compactionEffort(id)).toBe("high");
    }
    for (const id of ["claude-opus-4-8", "claude-haiku-4-5-20251001", "gpt-5.5", "gpt-6-sol", "mystery", undefined]) {
      expect(compactionEffort(id)).toBeUndefined();
    }
    const config: CairnConfig = {
      enabledModes: ["account", "api"],
      endpoints: { main: { provider: "anthropic", baseUrl: "https://api.example.test" } },
      storePath: ":memory:",
    };
    const fetchFn = vi.fn(async () => ({ json: async () => ({ content: [{ type: "text", text: "1) DECISIONS x" }], stop_reason: "end_turn" }) }));
    await runHandoff(
      { brief: "", source: "src", host: { modelId: "claude-opus-5-5" }, sourceZone: "green", mode: "api" },
      { store: new SqliteStore({ path: ":memory:" }), config, fetchFn: fetchFn as unknown as FetchFn },
    );
    const sent = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.output_config).toEqual({ effort: "high" });
    // At `high`, max_tokens must also hold the thinking: the brief budget is raised to EFFORT_MAX_TOKENS.
    expect(sent.max_tokens).toBe(EFFORT_MAX_TOKENS);
  });

  it("sampling and bridge mode keep the plain brief budget and carry no effort field", async () => {
    for (const mode of ["sampling", "bridge"] as const) {
      const config: CairnConfig = { enabledModes: ["account", mode], endpoints: {}, bridgeCli: "claude", storePath: ":memory:" };
      const caller = vi.fn<ModelCaller>(async () => ({ text: "1) DECISIONS x", truncated: false, finishReason: "stop" }));
      await runHandoff(
        { brief: "", source: "src", host: { modelId: "claude-opus-5-5" }, sourceZone: "green", mode },
        { store: new SqliteStore({ path: ":memory:" }), config, sample: caller, bridge: caller },
      );
      const req = caller.mock.calls[0][0];
      expect(req.maxTokens).toBe(6_144);
      expect(req.effort).toBeUndefined();
    }
  });

  it("a legacy model in API mode gets no effort field and the plain brief budget", async () => {
    const config: CairnConfig = {
      enabledModes: ["account", "api"],
      endpoints: { main: { provider: "anthropic", baseUrl: "https://api.example.test" } },
      storePath: ":memory:",
    };
    const fetchFn = vi.fn(async () => ({ json: async () => ({ content: [{ type: "text", text: "1) DECISIONS x" }], stop_reason: "end_turn" }) }));
    await runHandoff(
      { brief: "", source: "src", host: { modelId: "claude-haiku-4-5-20251001" }, sourceZone: "green", mode: "api" },
      { store: new SqliteStore({ path: ":memory:" }), config, fetchFn: fetchFn as unknown as FetchFn },
    );
    const sent = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent).not.toHaveProperty("output_config");
    expect(sent.max_tokens).toBe(6_144); // dynamicMaxTokens(4096 × 1.5, cap 8192)
  });
});
