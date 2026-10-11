/**
 * Cairn - provenance of a calibration run (ADR-0012): which code and which CLIs produced an artifact,
 * so a paid run can be checked later without running it again.
 */

import { execFileSync } from "node:child_process";

export interface RunProvenance {
  /** `git rev-parse HEAD` where the run started; null outside a git checkout. */
  commit: string | null;
  /** Tracked files differed from `commit` (untracked files do not count); null when unknown. */
  dirty: boolean | null;
  node: string;
  /** `claude --version` / `codex --version`, for live runs only: a dry run must not start either CLI. */
  cli?: { claude: string | null; codex: string | null };
}

/** Runs a local command and returns its trimmed stdout; throws on failure. Injectable for tests. */
export type RunCommand = (cmd: string, args: string[]) => string;

const defaultRun: RunCommand = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }).trim();

function firstLine(run: RunCommand, cmd: string, args: string[]): string | null {
  try {
    return run(cmd, args).split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

export function collectProvenance(opts: { live: boolean; run?: RunCommand }): RunProvenance {
  const run = opts.run ?? defaultRun;
  const commit = firstLine(run, "git", ["rev-parse", "HEAD"]);
  let dirty: boolean | null = null;
  if (commit) {
    try {
      dirty = run("git", ["status", "--porcelain", "--untracked-files=no"]).trim().length > 0;
    } catch {
      dirty = null;
    }
  }
  return {
    commit,
    dirty,
    node: process.version,
    ...(opts.live
      ? { cli: { claude: firstLine(run, "claude", ["--version"]), codex: firstLine(run, "codex", ["--version"]) } }
      : {}),
  };
}
