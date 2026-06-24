import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function repoFile(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
}

describe("Claude Code integration artifacts", () => {
  it("SKILL.md has the required frontmatter (name + description)", () => {
    const skill = repoFile(".claude/skills/cairn/SKILL.md");
    expect(skill.startsWith("---")).toBe(true);
    expect(skill).toMatch(/^name:\s*.+/m);
    expect(skill).toMatch(/^description:\s*.+/m);
    // Mentions all four tools so the agent knows the surface.
    for (const tool of ["context_status", "handoff", "decision_log", "host_status"]) {
      expect(skill).toContain(tool);
    }
  });

  it("mcp.json is valid and registers the cairn stdio server", () => {
    const mcp = JSON.parse(repoFile("integration/claude/mcp.json"));
    expect(mcp.mcpServers.cairn.type).toBe("stdio");
    expect(mcp.mcpServers.cairn.command).toBe("node");
    expect(mcp.mcpServers.cairn.args[0]).toMatch(/dist\/server\.js$/);
  });

  it("settings.example.json wires statusline + SessionStart + PreCompact", () => {
    const s = JSON.parse(repoFile("integration/claude/settings.example.json"));
    expect(s.statusLine.type).toBe("command");
    expect(s.statusLine.command).toMatch(/cairn-statusline/);
    expect(s.hooks.SessionStart[0].hooks[0].command).toMatch(/cairn-session-start/);
    expect(s.hooks.PreCompact[0].hooks[0].command).toMatch(/cairn-precompact/);
  });
});

describe("Codex integration artifacts", () => {
  it("the Codex SKILL.md has frontmatter and is honest about on-demand-only", () => {
    const skill = repoFile(".agents/skills/cairn/SKILL.md");
    expect(skill).toMatch(/^name:\s*.+/m);
    expect(skill).toMatch(/^description:\s*.+/m);
    expect(skill).toContain("handoff");
    // Codex has no ambient surface - the skill must say so.
    expect(skill.toLowerCase()).toMatch(/no statusline|no ambient|on-demand/);
    expect(skill.toLowerCase()).toContain("sampling");
  });

  it("config.snippet.toml registers the cairn stdio server under [mcp_servers.cairn]", () => {
    const toml = repoFile("integration/codex/config.snippet.toml");
    expect(toml).toMatch(/\[mcp_servers\.cairn\]/);
    expect(toml).toMatch(/command\s*=\s*"node"/);
    expect(toml).toMatch(/dist\/server\.js/);
  });

  it("AGENTS.cairn.md instructs on-demand use of the tools", () => {
    const agents = repoFile("integration/codex/AGENTS.cairn.md");
    for (const tool of ["context_status", "handoff", "decision_log"]) {
      expect(agents).toContain(tool);
    }
  });
});
