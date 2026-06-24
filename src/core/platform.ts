/**
 * Cairn - cross-platform helpers (Linux / macOS / Windows).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface CommandLookupOpts {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * Is `name` an executable on PATH? Pure PATH scan - no subprocess, so no dependency on `which`
 * (which doesn't exist on Windows cmd.exe/PowerShell). On Windows it also tries the PATHEXT
 * extensions (.cmd/.exe/…), since npm-installed CLIs are `claude.cmd` etc., not bare `claude`.
 * OS edges are injectable for testing.
 */
export function commandOnPath(name: string, opts: CommandLookupOpts = {}): boolean {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const isWin = platform === "win32";

  const pathVar = env.PATH ?? env.Path ?? "";
  const dirs = pathVar.split(isWin ? ";" : ":").filter(Boolean);
  if (dirs.length === 0) return false;

  const exts = isWin
    ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase())]
    : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      if (existsSync(join(dir, name + ext))) return true;
    }
  }
  return false;
}
