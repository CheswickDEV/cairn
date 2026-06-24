/**
 * Cairn - suppress the single `node:sqlite` ExperimentalWarning in-process.
 *
 * Importing this module (side-effect) installs a `process.emitWarning` filter that swallows ONLY the
 * node:sqlite experimental warning and passes everything else through. It is imported first in
 * `store/sqlite-store.ts` (the sole `node:sqlite` importer), so the warning is silenced across every
 * entry point - server, bins, calibration, tests - without a bash `NODE_OPTIONS=` prefix (which fails
 * on Windows cmd.exe/PowerShell) or any dependency.
 */

/** Pure predicate: is this the node:sqlite experimental warning? */
export function shouldSuppressSqliteWarning(warning: unknown, type?: unknown): boolean {
  const t = typeof type === "string" ? type : (type as { type?: unknown } | undefined)?.type;
  const text = typeof warning === "string" ? warning : ((warning as { message?: unknown } | null)?.message ?? "");
  return t === "ExperimentalWarning" && /sqlite/i.test(String(text));
}

let installed = false;

export function installWarningFilter(): void {
  if (installed) return;
  installed = true;
  const original = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  const filtered = (warning: unknown, ...rest: unknown[]): void => {
    if (shouldSuppressSqliteWarning(warning, rest[0])) return;
    original(warning, ...rest);
  };
  (process as unknown as { emitWarning: typeof filtered }).emitWarning = filtered;
}

installWarningFilter();
