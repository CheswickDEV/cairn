import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { collectProvenance, collectsCliVersions, gitNeutralEnv, PACKAGE_ROOT, type RunCommand } from "./provenance.js";

const SHA = "6b6cc61aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ROOT = "/repo/cairn";
const GIT = (...a: string[]) => `git -C ${ROOT} ${a.join(" ")}`;

function fakeRun(out: Record<string, string | Error>): ReturnType<typeof vi.fn<RunCommand>> {
  return vi.fn<RunCommand>((cmd, args) => {
    const v = out[`${cmd} ${args.join(" ")}`];
    if (v === undefined || v instanceof Error) throw v ?? new Error(`unexpected ${cmd} ${args.join(" ")}`);
    return v;
  });
}

const CLEAN = {
  [GIT("rev-parse", "--show-toplevel")]: ROOT,
  [GIT("rev-parse", "HEAD")]: SHA,
  [GIT("status", "--porcelain", "--untracked-files=no")]: "",
};

describe("run provenance (ADR-0012)", () => {
  it("records commit and a clean tree; a dry or offline run starts no CLI", () => {
    const run = fakeRun(CLEAN);
    expect(collectProvenance({ live: false, run, root: ROOT })).toEqual({ commit: SHA, dirty: false, node: process.version });
    expect(run.mock.calls.every(([cmd]) => cmd === "git")).toBe(true);
  });

  it("only a real run collects CLI versions", () => {
    expect(collectsCliVersions("real")).toBe(true);
    expect(collectsCliVersions("dry-run")).toBe(false);
    expect(collectsCliVersions("offline")).toBe(false);
  });

  it("a live run adds the first non-empty line of `claude --version` and `codex --version`", () => {
    const run = fakeRun({
      ...CLEAN,
      [GIT("status", "--porcelain", "--untracked-files=no")]: " M src/x.ts",
      "claude --version": "2.1.296 (Claude Code)",
      "codex --version": "\ncodex-cli 0.162.1\nextra",
    });
    const p = collectProvenance({ live: true, run, root: ROOT });
    expect(p.dirty).toBe(true);
    expect(p.cli).toEqual({ claude: "2.1.296 (Claude Code)", codex: "codex-cli 0.162.1" });
  });

  it("asks git in the package root, and records no commit when that root is not a checkout's top level", () => {
    // e.g. an installed package in another repo's node_modules, or a subfolder of a monorepo
    const run = fakeRun({ ...CLEAN, [GIT("rev-parse", "--show-toplevel")]: "/somewhere/else" });
    expect(collectProvenance({ live: false, run, root: ROOT })).toEqual({ commit: null, dirty: null, node: process.version });
    expect(run).not.toHaveBeenCalledWith("git", ["-C", ROOT, "rev-parse", "HEAD"]);
  });

  it("defaults to this package's root, independent of the cwd", () => {
    const run = fakeRun({});
    collectProvenance({ live: false, run });
    expect(run).toHaveBeenCalledWith("git", ["-C", PACKAGE_ROOT, "rev-parse", "--show-toplevel"]);
    expect(PACKAGE_ROOT).toBe(fileURLToPath(new URL("../..", import.meta.url)).replace(/[\\/]$/, ""));
  });

  it("git runs without variables that would point it at another repository", () => {
    const env = gitNeutralEnv({ PATH: "/bin", GIT_DIR: "/other/.git", GIT_WORK_TREE: "/other", GIT_INDEX_FILE: "/x" });
    expect(env).toEqual({ PATH: "/bin" });
  });

  it("status output beyond the exec buffer counts as dirty; any other failure is unknown", () => {
    const enobufs = Object.assign(new Error("spawnSync git ENOBUFS"), { code: "ENOBUFS" });
    const big = fakeRun({ ...CLEAN, [GIT("status", "--porcelain", "--untracked-files=no")]: enobufs });
    expect(collectProvenance({ live: false, run: big, root: ROOT }).dirty).toBe(true);
    const other = fakeRun({ ...CLEAN, [GIT("status", "--porcelain", "--untracked-files=no")]: new Error("index.lock") });
    expect(collectProvenance({ live: false, run: other, root: ROOT }).dirty).toBeNull();
  });

  it("a failing command yields null, never a thrown error", () => {
    const run = fakeRun({ [GIT("rev-parse", "--show-toplevel")]: new Error("not a git repository") });
    expect(collectProvenance({ live: true, run, root: ROOT })).toEqual({
      commit: null,
      dirty: null,
      node: process.version,
      cli: { claude: null, codex: null },
    });
  });
});
