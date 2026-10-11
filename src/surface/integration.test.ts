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

  it("manual/plugin setup installs no automatic session or compaction hooks", () => {
    const s = JSON.parse(repoFile("integration/claude/settings.example.json"));
    expect(s.statusLine.type).toBe("command");
    expect(s.statusLine.command).toMatch(/cairn-statusline/);
    expect(s.hooks).toBeUndefined();
    expect(JSON.parse(repoFile("hooks/hooks.json")).hooks).toEqual({});
  });
});

describe("Codex integration artifacts", () => {
  it("the Codex SKILL.md has frontmatter and is honest about on-demand-only", () => {
    const skill = repoFile(".agents/skills/cairn/SKILL.md");
    expect(skill).toMatch(/^name:\s*.+/m);
    expect(skill).toMatch(/^description:\s*.+/m);
    expect(skill).toContain("handoff");
    expect(skill.toLowerCase()).toContain("explicit requests only");
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

describe("shipped skill invocation controls", () => {
  for (const name of ["cairn", "cairn-handoff", "cairn-resume", "cairn-help"]) {
    it(`${name} ships explicit-only controls for each host and matching instructions`, () => {
      const claude = repoFile(`skills/${name}/SKILL.md`);
      const codex = repoFile(`.agents/skills/${name}/SKILL.md`);
      expect(claude).toMatch(/^disable-model-invocation: true$/m);
      expect(repoFile(`.claude/skills/${name}/SKILL.md`)).toBe(claude);
      expect(claude.replace("disable-model-invocation: true\n", "")).toBe(codex);
      expect(repoFile(`.agents/skills/${name}/agents/openai.yaml`)).toMatch(/allow_implicit_invocation:\s*false/);
    });
  }
  it("includes Codex policies in the installable package", () => {
    expect(JSON.parse(repoFile("package.json")).files).toContain(".agents/skills");
  });
});
