import { describe, it, expect, vi } from "vitest";
import {
  bridgeCompact,
  defaultExec,
  managedMcpConfigPath,
  managedMcpConfigPresent,
  parseCodexJsonl,
  runBridge,
  stripPreamble,
  type ExecFn,
} from "./bridge.js";

const req = { prompt: "compact this source", maxTokens: 1024, model: "claude-opus-4-8" };

describe("defaultExec", () => {
  const BIG = "x".repeat(8 * 1024 * 1024); // far beyond any pipe buffer

  it("a CLI that exits without reading stdin is a normal failed result, not a crash (EPIPE)", async () => {
    const r = await defaultExec(process.execPath, ["-e", "process.exit(3)"], { stdin: BIG, timeoutMs: 20_000 });
    expect(r.code).toBe(3);
  });

  it("a CLI that read only part of the prompt fails even with exit 0 (no answer to a truncated prompt)", async () => {
    const readOnce = "process.stdin.once('data', () => { process.stdout.write('answer'); process.exit(0); })";
    const r = await defaultExec(process.execPath, ["-e", readOnce], { stdin: BIG, timeoutMs: 20_000 });
    expect(r.stdout).toBe("answer");
    expect(r.code).toBe(1);
    // first, so a caller that keeps only the start of stderr still sees it
    expect(r.stderr).toMatch(/^\[cairn\] prompt not fully written/);
  });

  it("a CLI that reads the whole prompt keeps its exit code and output", async () => {
    const echoLen = "let n = 0; process.stdin.on('data', (d) => (n += d.length)).on('end', () => process.stdout.write(String(n)))";
    const r = await defaultExec(process.execPath, ["-e", echoLen], { stdin: BIG, timeoutMs: 20_000 });
    expect(r).toEqual({ stdout: String(BIG.length), stderr: "", code: 0 });
  });
});

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
        "--ignore-rules",
        "--ephemeral",
        "-C",
      ]),
    );
    expect(opts.stdin).toContain("7BUCKET");
    expect(opts.stdin).toContain("compact this source");
    expect(r.text).toBe("1) DECISIONS\nok");
  });
});

describe("context isolation (ADR-0012)", () => {
  const claudeExec = () => vi.fn<ExecFn>(async () => ({ stdout: JSON.stringify({ result: "1) DECISIONS" }), stderr: "", code: 0 }));

  it("claude: no MCP server or MCP tool, no transcript", async () => {
    const exec = claudeExec();
    await runBridge({ cli: "claude", system: "S", user: "U", execFn: exec, managedMcp: () => false });
    const args = exec.mock.calls[0][1];
    // `--tools ""` covers built-in tools only; strict mode without `--mcp-config` loads no MCP server
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("mcp__*");
    expect(args).toContain("--no-session-persistence");
  });

  it("claude: under a managed-mcp.json no strict mode (Claude Code would exit at startup), MCP tools still denied", async () => {
    const exec = claudeExec();
    await runBridge({ cli: "claude", system: "S", user: "U", execFn: exec, managedMcp: () => true });
    const args = exec.mock.calls[0][1];
    expect(args).not.toContain("--strict-mcp-config");
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("mcp__*");
  });

  it("finds a managed-mcp.json at the documented path; existence decides, not parsing", () => {
    expect(managedMcpConfigPath("linux")).toBe("/etc/claude-code/managed-mcp.json");
    expect(managedMcpConfigPath("darwin")).toBe("/Library/Application Support/ClaudeCode/managed-mcp.json");
    expect(managedMcpConfigPath("win32")).toBe("C:\\Program Files\\ClaudeCode\\managed-mcp.json");
    // Claude Code keeps exclusive control even over a file it cannot parse, and it accepts a UTF-8 BOM
    // our JSON.parse would reject, so the bridge never parses the file.
    const exists = vi.fn((path: string) => path === "/Library/Application Support/ClaudeCode/managed-mcp.json");
    expect(managedMcpConfigPresent(exists, "darwin")).toBe(true);
    expect(exists).toHaveBeenCalledWith("/Library/Application Support/ClaudeCode/managed-mcp.json");
    expect(managedMcpConfigPresent(exists, "linux")).toBe(false);
  });

  it("claude: no CLAUDE.md and no claude.ai connectors, in the child env and via --settings, also without an effort", async () => {
    const isolation = { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
    for (const effort of [undefined, "high"]) {
      const exec = claudeExec();
      await bridgeCompact({ cli: "claude", request: req, effort, execFn: exec });
      const [, args, opts] = exec.mock.calls[0];
      expect(opts.env).toMatchObject(isolation);
      const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
      expect(settings.disableClaudeAiConnectors).toBe(true);
      expect(settings.env).toMatchObject(isolation);
    }
  });

  it("codex: no skills catalog, no project AGENTS.md from the tmpdir cwd, no apps connector, no sub-agents, no user rules", async () => {
    const jsonl = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "1) DECISIONS" } });
    const exec = vi.fn<ExecFn>(async () => ({ stdout: jsonl, stderr: "", code: 0 }));
    await bridgeCompact({ cli: "codex", request: req, effort: "high", execFn: exec });
    const args = exec.mock.calls[0][1];
    const overrides = args.flatMap((a, i) => (a === "-c" ? [args[i + 1]] : []));
    expect(overrides).toEqual(
      expect.arrayContaining([
        "skills.include_instructions=false",
        "project_doc_max_bytes=0",
        "features.apps=false",
        "agents.enabled=false",
        "features.multi_agent_v2=false",
      ]),
    );
    // execpolicy allow rules would let a matching command bypass the read-only sandbox
    expect(args).toContain("--ignore-rules");
    expect(overrides).toContain("model_reasoning_effort=high");
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
