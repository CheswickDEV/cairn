import { describe, it, expect, vi } from "vitest";
import { collectProvenance, type RunCommand } from "./provenance.js";

const SHA = "6b6cc61aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function fakeRun(out: Record<string, string | Error>): ReturnType<typeof vi.fn<RunCommand>> {
  return vi.fn<RunCommand>((cmd, args) => {
    const v = out[`${cmd} ${args.join(" ")}`];
    if (v === undefined || v instanceof Error) throw v ?? new Error(`unexpected ${cmd}`);
    return v;
  });
}

describe("run provenance (ADR-0012)", () => {
  it("records commit and a clean tree; a dry or offline run starts no CLI", () => {
    const run = fakeRun({ "git rev-parse HEAD": SHA, "git status --porcelain --untracked-files=no": "" });
    const p = collectProvenance({ live: false, run });
    expect(p).toEqual({ commit: SHA, dirty: false, node: process.version });
    expect(run.mock.calls.map(([cmd]) => cmd)).toEqual(["git", "git"]);
  });

  it("a live run adds the first line of `claude --version` and `codex --version`", () => {
    const run = fakeRun({
      "git rev-parse HEAD": SHA,
      "git status --porcelain --untracked-files=no": " M src/x.ts",
      "claude --version": "2.1.296 (Claude Code)",
      "codex --version": "codex-cli 0.162.1\nextra",
    });
    const p = collectProvenance({ live: true, run });
    expect(p.dirty).toBe(true);
    expect(p.cli).toEqual({ claude: "2.1.296 (Claude Code)", codex: "codex-cli 0.162.1" });
  });

  it("a failing command yields null, never a thrown error", () => {
    const run = fakeRun({ "git rev-parse HEAD": new Error("not a git repository") });
    expect(collectProvenance({ live: true, run })).toEqual({
      commit: null,
      dirty: null,
      node: process.version,
      cli: { claude: null, codex: null },
    });
  });
});
