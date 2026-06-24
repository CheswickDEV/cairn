import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { detectHostStatus, type HostProbe } from "./host-detect.js";

function probe(opts: { commands?: string[]; files?: string[]; home?: string }): HostProbe {
  const commands = new Set(opts.commands ?? []);
  const files = new Set(opts.files ?? []);
  return {
    commandExists: (c) => commands.has(c),
    fileExists: (p) => files.has(p),
    homedir: () => opts.home ?? "/home/u",
  };
}

describe("detectHostStatus", () => {
  it("reliably reports installed CLIs and best-effort login from config-file presence", () => {
    const r = detectHostStatus(
      probe({ commands: ["claude"], files: [join("/home/u", ".claude.json")] }),
      "en",
      { CAIRN_HOST_MODEL: "Claude Opus 4.8" },
    );
    const claude = r.clis.find((c) => c.cli === "claude")!;
    const codex = r.clis.find((c) => c.cli === "codex")!;

    expect(claude.installed).toBe(true);
    expect(claude.loggedIn).toBe(true);
    expect(claude.activeModel).toBe("Claude Opus 4.8");
    expect(codex.installed).toBe(false);
    expect(codex.loggedIn).toBe("unknown");
    // English is the default recommendation language.
    expect(r.recommendation).toContain("claude signed in");
    expect(r.recommendation).toContain("codex not found");
    expect(r.recommendation).toContain("GPT-5.5");
  });

  it("renders the recommendation in German when lang = 'de'", () => {
    const r = detectHostStatus(
      probe({ commands: ["claude"], files: [join("/home/u", ".claude.json")] }),
      "de",
      { CAIRN_HOST_MODEL: "Claude Opus 4.8" },
    );
    expect(r.recommendation).toContain("claude angemeldet");
    expect(r.recommendation).toContain("codex nicht gefunden");
    expect(r.recommendation).toContain("GPT-5.5");
  });

  it("flags an installed-but-not-logged-in CLI as best-effort, not 'unknown'", () => {
    const r = detectHostStatus(probe({ commands: ["claude", "codex"], files: [] }), "en", {});
    expect(r.clis.every((c) => c.installed)).toBe(true);
    expect(r.clis.every((c) => c.loggedIn === false)).toBe(true);
    expect(r.recommendation).toContain("no login detected");
    expect(detectHostStatus(probe({ commands: ["claude", "codex"], files: [] }), "de", {}).recommendation).toContain(
      "kein Login erkannt",
    );
  });

  it("always labels login detection as best-effort (both locales)", () => {
    expect(detectHostStatus(probe({}), "en", {}).loginDetectionNote.toLowerCase()).toContain("best-effort");
    expect(detectHostStatus(probe({}), "de", {}).loginDetectionNote.toLowerCase()).toContain("best-effort");
  });
});
