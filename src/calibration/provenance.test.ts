import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const env = gitNeutralEnv({
      PATH: "/bin",
      GIT_DIR: "/other/.git",
      GIT_WORK_TREE: "/other",
      GIT_INDEX_FILE: "/x",
      GIT_COMMON_DIR: "/other/.git",
      GIT_OBJECT_DIRECTORY: "/other/.git/objects",
    });
    expect(env).toEqual({ PATH: "/bin" });
  });

  const hasGit = (() => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore", env: gitNeutralEnv() });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasGit)("with the real git, an exported GIT_DIR of another repo does not change the recorded commit", () => {
    // Hermetic: no user/system git config (signing, hooks), so only this test's repos matter.
    const env = { ...gitNeutralEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (cwd: string, ...a: string[]) =>
      execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...a], {
        cwd,
        encoding: "utf8",
        env,
      }).trim();
    const mkRepo = (message: string) => {
      const dir = mkdtempSync(join(tmpdir(), "cairn-prov-"));
      git(dir, "init", "-q");
      git(dir, "commit", "-q", "--no-verify", "--allow-empty", "-m", message);
      return dir;
    };
    const ours = mkRepo("ours");
    const foreign = mkRepo("foreign");
    const head = git(ours, "rev-parse", "HEAD");
    expect(git(foreign, "rev-parse", "HEAD")).not.toBe(head); // a leaked GIT_DIR would show up as the commit
    vi.stubEnv("GIT_DIR", join(foreign, ".git"));
    vi.stubEnv("GIT_WORK_TREE", foreign);
    try {
      const p = collectProvenance({ live: false, root: ours });
      expect(p.commit).toBe(head);
      expect(p.dirty).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(ours, { recursive: true, force: true });
      rmSync(foreign, { recursive: true, force: true });
    }
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
