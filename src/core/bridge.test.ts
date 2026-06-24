import { describe, it, expect, vi } from "vitest";
import { bridgeCompact, parseCodexJsonl, stripPreamble, type ExecFn } from "./bridge.js";

const req = { prompt: "compact this source", maxTokens: 1024, model: "claude-opus-4-8" };

describe("bridgeCompact — claude -p (hardened)", () => {
  it("passes the directive as --system-prompt (+exclude-dynamic) and the SOURCE on stdin", async () => {
    const exec = vi.fn<ExecFn>(async () => ({
      stdout: JSON.stringify({ result: "1) DECISIONS\n...", subtype: "success" }),
      stderr: "",
      code: 0,
    }));
    const r = await bridgeCompact({ cli: "claude", request: { ...req, systemPrompt: "7BUCKET" }, execFn: exec });
    const [cmd, args, opts] = exec.mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args).toEqual(
      expect.arrayContaining([
        "-p",
        "--output-format",
        "json",
        "--system-prompt",
        "--exclude-dynamic-system-prompt-sections",
        "--tools",
        "--permission-mode",
        "default",
        "--model",
        "claude-opus-4-8",
      ]),
    );
    // Tools are structurally disabled and permissions are never bypassed (audit finding 1).
    expect(args[args.indexOf("--tools") + 1]).toBe(""); // disable ALL tools
    expect(args).not.toContain("--dangerously-skip-permissions");
    // The system prompt carries the 7-bucket + brief-only directive; the source is on stdin.
    const sysIdx = args.indexOf("--system-prompt") + 1;
    expect(args[sysIdx]).toContain("7BUCKET");
    expect(args[sysIdx]).toContain("1) DECISIONS");
    expect(opts.stdin).toBe("compact this source");
    expect(opts.cwd).toBeTruthy(); // neutral cwd
    expect(r.text).toBe("1) DECISIONS\n...");
  });

  it("drops an unsafe --model value (no flag injection via host.modelId)", async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: JSON.stringify({ result: "1) DECISIONS" }), stderr: "", code: 0 }));
    await bridgeCompact({ cli: "claude", request: { ...req, model: "--dangerously-skip-permissions" }, execFn: exec });
    const args = exec.mock.calls[0][1];
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("strips an agent preamble from the result", async () => {
    const exec = vi.fn<ExecFn>(async () => ({
      stdout: JSON.stringify({ result: "Hinweis: bla bla.\n\n1) DECISIONS\nx", subtype: "success" }),
      stderr: "",
      code: 0,
    }));
    const r = await bridgeCompact({ cli: "claude", request: req, execFn: exec });
    expect(r.text.startsWith("1) DECISIONS")).toBe(true);
  });

  it("throws on a non-zero exit with empty stdout", async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: "", stderr: "not logged in", code: 1 }));
    await expect(bridgeCompact({ cli: "claude", request: req, execFn: exec })).rejects.toThrow(/claude bridge failed/);
  });
});

describe("bridgeCompact — codex exec (hardened)", () => {
  it("runs read-only in a neutral cwd, folds the directive into stdin, parses agent_message", async () => {
    const jsonl = [
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "1) DECISIONS\nok" } }),
    ].join("\n");
    const exec = vi.fn<ExecFn>(async () => ({ stdout: jsonl, stderr: "", code: 0 }));
    const r = await bridgeCompact({ cli: "codex", request: { ...req, systemPrompt: "7BUCKET" }, execFn: exec });
    const [cmd, args, opts] = exec.mock.calls[0];
    expect(cmd).toBe("codex");
    expect(args).toEqual(
      expect.arrayContaining([
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--ignore-user-config",
        "--ephemeral",
        "-C",
      ]),
    );
    expect(opts.stdin).toContain("7BUCKET");
    expect(opts.stdin).toContain("compact this source");
    expect(r.text).toBe("1) DECISIONS\nok");
  });
});

describe("effort injection", () => {
  it("claude: passes --effort <level>", async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: JSON.stringify({ result: "1) DECISIONS" }), stderr: "", code: 0 }));
    await bridgeCompact({ cli: "claude", request: req, effort: "xhigh", execFn: exec });
    const args = exec.mock.calls[0][1];
    expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");
  });

  it("codex: passes -c model_reasoning_effort=<level>", async () => {
    const jsonl = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "1) DECISIONS" } });
    const exec = vi.fn<ExecFn>(async () => ({ stdout: jsonl, stderr: "", code: 0 }));
    await bridgeCompact({ cli: "codex", request: req, effort: "high", execFn: exec });
    const args = exec.mock.calls[0][1];
    expect(args).toContain("-c");
    expect(args).toContain("model_reasoning_effort=high");
  });

  it("rejects a non-word effort value (no flag/config injection)", async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: JSON.stringify({ result: "x" }), stderr: "", code: 0 }));
    await bridgeCompact({ cli: "claude", request: req, effort: "high; rm -rf", execFn: exec });
    expect(exec.mock.calls[0][1]).not.toContain("--effort");
  });
});

describe("stripPreamble", () => {
  it("trims everything before the first DECISIONS bucket", () => {
    expect(stripPreamble("waffle\n\n1) DECISIONS\nbody")).toBe("1) DECISIONS\nbody");
    expect(stripPreamble("DECISIONS: x")).toBe("DECISIONS: x");
  });
  it("returns trimmed text unchanged when no bucket marker is present", () => {
    expect(stripPreamble("  just a brief  ")).toBe("just a brief");
  });
});

describe("parseCodexJsonl", () => {
  it("extracts the agent_message from item.completed events", () => {
    const out = [
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "the brief" } }),
    ].join("\n");
    expect(parseCodexJsonl(out)).toBe("the brief");
  });

  it("tolerates non-JSON lines and falls back to a plain text field", () => {
    const out = ["garbage", JSON.stringify({ text: "a" }), JSON.stringify({ text: "b" })].join("\n");
    expect(parseCodexJsonl(out)).toBe("b");
  });
});
