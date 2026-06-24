import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeClaudeSettings,
  unmergeClaudeSettings,
  addCodexBlock,
  removeCodexBlock,
  codexBlock,
  CODEX_BLOCK_HEADER,
  conflictingProjectMcp,
  addCodexAgents,
  removeCodexAgents,
  CODEX_AGENTS_BEGIN,
  statuslineCmd,
  sessionStartCmd,
  preCompactCmd,
  SERVER_JS,
  runInstaller,
  parseLangArg,
  resolveInstallLang,
} from "./installer.js";

const BIN = "/opt/cairn/dist/bin";

describe("installer — Claude settings.json merge", () => {
  it("adds statusline + both hooks, preserving foreign hooks", () => {
    const foreign = { matcher: "startup", hooks: [{ type: "command", command: "echo other" }] };
    const merged = mergeClaudeSettings({ hooks: { SessionStart: [foreign] } }, BIN) as any;
    expect(merged.statusLine.command).toContain("cairn-statusline.js");
    expect(merged.hooks.SessionStart).toContainEqual(foreign); // foreign survives
    expect(JSON.stringify(merged.hooks.SessionStart)).toContain("cairn-session-start.js");
    expect(JSON.stringify(merged.hooks.PreCompact)).toContain("cairn-precompact.js");
  });

  it("is idempotent — merging twice yields one cairn entry per hook", () => {
    const once = mergeClaudeSettings({}, BIN);
    const twice = mergeClaudeSettings(once, BIN) as any;
    const cairnSession = (twice.hooks.SessionStart as any[]).filter((e) =>
      JSON.stringify(e).includes("cairn-"),
    );
    expect(cairnSession).toHaveLength(1);
    expect(twice.hooks.PreCompact).toHaveLength(1);
  });

  it("unmerge removes exactly the cairn entries and restores cleanliness", () => {
    const foreign = { matcher: "startup", hooks: [{ type: "command", command: "echo other" }] };
    const merged = mergeClaudeSettings({ hooks: { SessionStart: [foreign] } }, BIN);
    const clean = unmergeClaudeSettings(merged) as any;
    expect(clean.statusLine).toBeUndefined();
    expect(clean.hooks.SessionStart).toEqual([foreign]); // foreign kept
    expect(clean.hooks.PreCompact).toBeUndefined(); // had only cairn → key dropped
  });

  it("unmerge with no foreign hooks drops the hooks object entirely", () => {
    const clean = unmergeClaudeSettings(mergeClaudeSettings({}, BIN)) as any;
    expect(clean.hooks).toBeUndefined();
    expect(clean.statusLine).toBeUndefined();
  });
});

describe("installer — cross-platform command syntax (Windows)", () => {
  it("hook/statusline commands use a node flag, not a bash env-prefix", () => {
    // bash `VAR=val node …` fails under cmd.exe/PowerShell where Claude runs hooks on Windows.
    for (const c of [statuslineCmd("/b"), sessionStartCmd("/b"), preCompactCmd("/b")]) {
      expect(c).toContain("node --disable-warning=ExperimentalWarning");
      expect(c).not.toContain("NODE_OPTIONS=");
    }
  });

  it("codexBlock emits a Windows path as valid TOML (forward slashes, no backslash escapes)", () => {
    const b = codexBlock("C:\\Users\\dev\\My Tools\\cairn\\dist\\server.js");
    expect(b).toContain('args = ["C:/Users/dev/My Tools/cairn/dist/server.js"]');
    expect(b).not.toContain("\\"); // a backslash here would be an invalid TOML escape → corrupt config
  });
});

describe("installer — Codex config.toml block", () => {
  it("appends the cairn block once (idempotent)", () => {
    const base = '[mcp_servers.other]\ncommand = "x"\n';
    const once = addCodexBlock(base, "/srv.js");
    expect(once).toContain(CODEX_BLOCK_HEADER);
    expect(once).toContain('args = ["/srv.js"]');
    expect(addCodexBlock(once, "/srv.js")).toBe(once); // no duplicate
  });

  it("removes the cairn block but keeps other tables", () => {
    const toml = '[mcp_servers.other]\ncommand = "x"\n\n' + codexBlock("/srv.js");
    const removed = removeCodexBlock(toml);
    expect(removed).not.toContain(CODEX_BLOCK_HEADER);
    expect(removed).toContain("[mcp_servers.other]");
  });
});

describe("installer — Codex AGENTS.md snippet (fenced, symmetric)", () => {
  const SNIPPET = "# Cairn\nUse the cairn tools.";

  it("adds the fenced block once (idempotent)", () => {
    const once = addCodexAgents("", SNIPPET);
    expect(once).toContain(CODEX_AGENTS_BEGIN);
    expect(once).toContain("Use the cairn tools.");
    expect(addCodexAgents(once, SNIPPET)).toBe(once); // no duplicate
  });

  it("round-trips: remove from a file created-from-empty yields '' (caller deletes)", () => {
    expect(removeCodexAgents(addCodexAgents("", SNIPPET))).toBe("");
  });

  it("refreshes the block content on re-add (replace in place, still exactly one block)", () => {
    const v1 = addCodexAgents("# My own AGENTS\nkeep me\n", "# Cairn v1\nold note");
    const v2 = addCodexAgents(v1, "# Cairn v2\nnew note");
    expect(v2).toContain("# Cairn v2");
    expect(v2).toContain("new note");
    expect(v2).not.toContain("old note"); // stale content replaced, not duplicated
    expect(v2).toContain("keep me"); // foreign content preserved
    expect((v2.match(/cairn:begin/g) ?? []).length).toBe(1);
  });

  it("preserves foreign content around the block on removal", () => {
    const withForeign = addCodexAgents("# My own AGENTS\nkeep me\n", SNIPPET);
    const cleaned = removeCodexAgents(withForeign);
    expect(cleaned).toContain("keep me");
    expect(cleaned).not.toContain(CODEX_AGENTS_BEGIN);
  });

  it("leaves a file without the marker untouched", () => {
    expect(removeCodexAgents("# foreign only\n")).toBe("# foreign only\n");
  });
});

describe("installer — project-scope .mcp.json conflict detection", () => {
  it("flags a cairn entry pointing at a different server.js", () => {
    const text = JSON.stringify({ mcpServers: { cairn: { args: ["/opt/claude/cairn/dist/server.js"] } } });
    expect(conflictingProjectMcp(text, "C:/x/dist/server.js")).toBe("/opt/claude/cairn/dist/server.js");
  });
  it("returns null when it points at us, has no cairn entry, or is junk", () => {
    expect(conflictingProjectMcp(JSON.stringify({ mcpServers: { cairn: { args: ["/me/dist/server.js"] } } }), "/me/dist/server.js")).toBeNull();
    expect(conflictingProjectMcp(JSON.stringify({ mcpServers: { other: { args: ["x"] } } }), "/me/dist/server.js")).toBeNull();
    expect(conflictingProjectMcp("not json", "/me/dist/server.js")).toBeNull();
    expect(conflictingProjectMcp(null, "/me/dist/server.js")).toBeNull();
  });
});

describe("installer — end-to-end against a temp HOME", () => {
  it("warns when the cwd has a conflicting project-scope .mcp.json", () => {
    const home = mkdtempSync(join(tmpdir(), "cairn-conf-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".mcp.json"),
        JSON.stringify({ mcpServers: { cairn: { args: ["/some/other/dist/server.js"] } } }),
        "utf8",
      );
      const logs: string[] = [];
      runInstaller("install", {
        home,
        cwd: home,
        hasCli: () => false,
        psProfilePaths: () => [join(home, "PowerShell", "profile.ps1")],
        log: (m) => logs.push(m),
        lang: "en",
      });
      const out = logs.join("\n");
      expect(out).toContain("Conflict: ./.mcp.json"); // English default
      expect(out).toContain("/some/other/dist/server.js");

      // German is selectable.
      const deLogs: string[] = [];
      runInstaller("install", {
        home,
        cwd: home,
        hasCli: () => false,
        psProfilePaths: () => [join(home, "PowerShell", "profile.ps1")],
        log: (m) => deLogs.push(m),
        lang: "de",
      });
      expect(deLogs.join("\n")).toContain("Konflikt: ./.mcp.json");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("install wires both hosts, uninstall reverses it (no host CLIs present)", () => {
    const home = mkdtempSync(join(tmpdir(), "cairn-inst-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true }); // make Claude "detected"
      mkdirSync(join(home, ".codex"), { recursive: true }); // make Codex "detected"
      const logs: string[] = [];
      const opts = {
        home,
        hasCli: () => false,
        psProfilePaths: () => [join(home, "PowerShell", "profile.ps1")],
        log: (m: string) => logs.push(m),
        lang: "en" as const,
      };

      runInstaller("install", opts);

      const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
      expect(settings.statusLine.command).toContain("cairn-statusline.js");
      expect(JSON.stringify(settings.hooks)).toContain("cairn-session-start.js");
      expect(existsSync(join(home, ".claude", "skills", "cairn", "SKILL.md"))).toBe(true);
      for (const s of ["cairn-handoff", "cairn-resume", "cairn-help"]) {
        expect(existsSync(join(home, ".claude", "skills", s, "SKILL.md"))).toBe(true);
      }

      const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
      expect(toml).toContain(CODEX_BLOCK_HEADER);
      expect(existsSync(join(home, ".agents", "skills", "cairn", "SKILL.md"))).toBe(true);
      for (const s of ["cairn-handoff", "cairn-resume", "cairn-help"]) {
        expect(existsSync(join(home, ".agents", "skills", s, "SKILL.md"))).toBe(true);
      }
      expect(existsSync(join(home, ".codex", "AGENTS.md"))).toBe(true); // created from empty

      // no claude CLI → printed manual guidance instead of running it
      expect(logs.join("\n")).toContain("claude mcp add cairn --scope user");

      runInstaller("uninstall", opts);
      const after = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
      expect(after.statusLine).toBeUndefined();
      expect(after.hooks).toBeUndefined();
      expect(existsSync(join(home, ".claude", "skills", "cairn"))).toBe(false);
      // config.toml was created from empty (only our block) → removed entirely on uninstall
      expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
      expect(existsSync(join(home, ".agents", "skills", "cairn"))).toBe(false);
      for (const s of ["cairn-handoff", "cairn-resume", "cairn-help"]) {
        expect(existsSync(join(home, ".claude", "skills", s))).toBe(false);
        expect(existsSync(join(home, ".agents", "skills", s))).toBe(false);
      }
      // the bug fix: AGENTS.md (100% ours, created from empty) is removed on uninstall
      expect(existsSync(join(home, ".codex", "AGENTS.md"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prints guidance when neither host is detected", () => {
    const home = mkdtempSync(join(tmpdir(), "cairn-none-"));
    try {
      const logs: string[] = [];
      runInstaller("install", { home, hasCli: () => false, log: (m) => logs.push(m), lang: "en" });
      expect(logs.join("\n")).toContain("No Claude Code"); // English default
      const deLogs: string[] = [];
      runInstaller("install", { home, hasCli: () => false, log: (m) => deLogs.push(m), lang: "de" });
      expect(deLogs.join("\n")).toContain("Kein Claude Code"); // German selectable
      expect(existsSync(join(home, ".claude"))).toBe(false); // nothing created
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("installer — install-time language selection", () => {
  it("parses --lang de|en (space and = forms), ignores invalid", () => {
    expect(parseLangArg(["--lang", "de"])).toBe("de");
    expect(parseLangArg(["--lang=en"])).toBe("en");
    expect(parseLangArg(["--lang", "fr"])).toBeUndefined();
    expect(parseLangArg(["--other", "x"])).toBeUndefined();
    expect(parseLangArg([])).toBeUndefined();
  });

  it("the --lang flag wins over the prompt/TTY", async () => {
    const prompt = vi.fn(async () => "de" as const);
    expect(await resolveInstallLang(["--lang", "en"], { isTTY: true, prompt })).toBe("en");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts once when no flag and a TTY is present", async () => {
    const prompt = vi.fn(async () => "de" as const);
    expect(await resolveInstallLang([], { isTTY: true, prompt })).toBe("de");
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("defaults to English non-interactively (no flag, no TTY)", async () => {
    const prompt = vi.fn(async () => "de" as const);
    expect(await resolveInstallLang([], { isTTY: false, prompt })).toBe("en");
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe("installer — help output", () => {
  it("lists installer + shell commands + the in-chat trigger phrases + MCP tools (English default)", () => {
    const logs: string[] = [];
    runInstaller("help", { log: (m) => logs.push(m), lang: "en" });
    const out = logs.join("\n");
    expect(out).toContain("cairn install");
    expect(out).toContain("cairn status"); // shell shortcut
    expect(out).toContain('"Cairn resume"'); // the trigger the Codex improvised help dropped
    expect(out).toContain('"Cairn Handoff"');
    expect(out).toContain('"Cairn Help"');
    expect(out).toContain("decision_log"); // MCP tool
    expect(out).toContain("wires Cairn into Claude Code"); // English-specific copy
  });

  it("prints the help in German when lang = 'de'", () => {
    const logs: string[] = [];
    runInstaller("help", { log: (m) => logs.push(m), lang: "de" });
    const out = logs.join("\n");
    expect(out).toContain("verdrahtet Cairn in Claude Code"); // German-specific copy
    expect(out).toContain('"Cairn resume"'); // triggers stay English in both locales
    expect(out).toContain("decision_log");
  });
});
