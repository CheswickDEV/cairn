/**
 * Cairn - provenance of a calibration run (ADR-0012): the git commit of this code and the CLI versions
 * behind an artifact, so a paid run can be checked later without running it again.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CalibConfig } from "./calib-config.js";

/** This package's root: `src/calibration` (tsx) or `dist/calibration` (build), two levels up. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface RunProvenance {
  /** HEAD of the git checkout holding this code; null unless the package root is the top level of a
   *  checkout with a commit (an installed package, a subfolder of another repo, an archive, an unborn
   *  HEAD or a missing `git` give null). */
  commit: string | null;
  /** Tracked files differ from `commit`; untracked and gitignored files (e.g. a stale `dist/`) do not
   *  count. null when unknown. */
  dirty: boolean | null;
  node: string;
  /** First non-empty line of `claude --version` / `codex --version`; real runs only, so a dry or offline
   *  run starts neither CLI. */
  cli?: { claude: string | null; codex: string | null };
}

/** Runs a local command and returns its trimmed stdout; throws on failure. Injectable for tests. */
export type RunCommand = (cmd: string, args: string[]) => string;

/** The environment without the variables that point git at another repository: an exported `GIT_DIR`
 *  (as in a git hook) would otherwise win over `git -C`. */
export function gitNeutralEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"]) delete out[k];
  return out;
}

// SIGKILL: no command here (git or a `--version`) may outlast the timeout by ignoring SIGTERM.
const defaultRun: RunCommand = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    timeout: 15_000,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
    env: gitNeutralEnv(),
  }).trim();

/** Only a real run asks the CLIs for their version (ADR-0012). */
export function collectsCliVersions(mode: CalibConfig["mode"]): boolean {
  return mode === "real";
}

function firstLine(run: RunCommand, cmd: string, args: string[]): string | null {
  try {
    return (
      run(cmd, args)
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? null
    );
  } catch {
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return norm(a) === norm(b);
}

function isDirty(run: RunCommand, root: string): boolean | null {
  try {
    return run("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"]).length > 0;
  } catch (e) {
    // Output beyond the exec buffer can only mean changes.
    return (e as NodeJS.ErrnoException).code === "ENOBUFS" ? true : null;
  }
}

export function collectProvenance(opts: { live: boolean; run?: RunCommand; root?: string }): RunProvenance {
  const run = opts.run ?? defaultRun;
  const root = opts.root ?? PACKAGE_ROOT;
  // From the package root, not the caller's cwd: a run started elsewhere must not record another repo.
  const top = firstLine(run, "git", ["-C", root, "rev-parse", "--show-toplevel"]);
  const commit = top && samePath(top, root) ? firstLine(run, "git", ["-C", root, "rev-parse", "HEAD"]) : null;
  return {
    commit,
    dirty: commit ? isDirty(run, root) : null,
    node: process.version,
    ...(opts.live
      ? { cli: { claude: firstLine(run, "claude", ["--version"]), codex: firstLine(run, "codex", ["--version"]) } }
      : {}),
  };
}
