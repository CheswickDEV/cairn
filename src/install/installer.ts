/**
 * Cairn - self-installer (`cairn install` / `cairn uninstall`).
 *
 * Wires Cairn into the detected host CLIs with no manual path editing:
 *  - Claude Code: merges the statusline + SessionStart/PreCompact hooks into ~/.claude/settings.json,
 *    copies the skill, and registers the MCP server via `claude mcp add` (or prints the command if the
 *    CLI is absent).
 *  - Codex: appends the `[mcp_servers.cairn]` block to ~/.codex/config.toml, the AGENTS snippet, and
 *    the skill.
 *
 * The merge/TOML helpers are pure (string in → string out) so they are unit-tested without touching a
 * real HOME. Everything is idempotent: re-running install does not duplicate entries; uninstall removes
 * exactly what install added (matched by the `cairn-` marker).
 */

import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { commandOnPath } from "../core/platform.js";
import { t, resolveLang, isLang, type Lang } from "../i18n/index.js";
import {
  mergeMarked,
  unmergeMarked,
  psShortcut,
  shShortcut,
  shSourceInner,
  type ShortcutPaths,
} from "./shell-shortcuts.js";

// ---- path resolution (works from dist/install/ in prod and src/install/ under vitest) ----
const HERE = dirname(fileURLToPath(import.meta.url));
export const DIST_DIR = resolve(HERE, "..");
export const ROOT_DIR = resolve(DIST_DIR, "..");
export const SERVER_JS = join(DIST_DIR, "server.js");
export const BIN_DIR = join(DIST_DIR, "bin");
/** Every skill the installer ships: the umbrella `cairn` skill plus the named action skills
 *  triggered by "Cairn resume" / "Cairn Handoff" / "Cairn Help". Each lives at `skills/<name>/SKILL.md`. */
export const SKILL_NAMES = ["cairn", "cairn-handoff", "cairn-resume", "cairn-help"] as const;
const skillSrc = (name: string): string => join(ROOT_DIR, "skills", name, "SKILL.md");
export const CODEX_AGENTS_SNIPPET = join(ROOT_DIR, "integration", "codex", "AGENTS.cairn.md");

// A Node CLI flag, NOT a bash env-prefix (`VAR=val node …`): Claude Code runs hooks via cmd.exe /
// PowerShell on Windows, where the bash prefix fails ("NODE_OPTIONS not recognized", exit 255).
// `node --disable-warning=… script` runs identically under cmd, PowerShell and bash.
const NODE_FLAG = "--disable-warning=ExperimentalWarning";
const CAIRN_MARKER = "cairn-";

// ---------- pure: command strings ----------
export function statuslineCmd(binDir: string): string {
  return `node ${NODE_FLAG} "${join(binDir, "cairn-statusline.js")}"`;
}
export function sessionStartCmd(binDir: string): string {
  return `node ${NODE_FLAG} "${join(binDir, "cairn-session-start.js")}"`;
}
export function preCompactCmd(binDir: string): string {
  return `node ${NODE_FLAG} "${join(binDir, "cairn-precompact.js")}"`;
}

// ---------- pure: Claude settings.json merge ----------
type Json = Record<string, unknown>;
type HookEntry = { matcher?: string; hooks: { type: string; command: string }[] };

function isCairnHook(entry: unknown): boolean {
  return JSON.stringify(entry ?? "").includes(CAIRN_MARKER);
}

function addHook(arr: unknown, matcher: string | undefined, command: string): HookEntry[] {
  const kept = Array.isArray(arr) ? (arr as HookEntry[]).filter((e) => !isCairnHook(e)) : [];
  const entry: HookEntry = { hooks: [{ type: "command", command }] };
  if (matcher) entry.matcher = matcher;
  return [...kept, entry];
}

/** Add Cairn's statusline + hooks to an existing settings object (idempotent). */
export function mergeClaudeSettings(existing: Json, binDir: string): Json {
  const s: Json = { ...existing };
  s.statusLine = { type: "command", command: statuslineCmd(binDir) };
  const hooks: Json = { ...((s.hooks as Json) ?? {}) };
  hooks.SessionStart = addHook(hooks.SessionStart, "startup|resume|compact", sessionStartCmd(binDir));
  hooks.PreCompact = addHook(hooks.PreCompact, undefined, preCompactCmd(binDir));
  s.hooks = hooks;
  return s;
}

/** Remove exactly what mergeClaudeSettings added (matched by the cairn- marker). */
export function unmergeClaudeSettings(existing: Json): Json {
  const s: Json = { ...existing };
  const sl = s.statusLine as { command?: string } | undefined;
  if (sl && typeof sl.command === "string" && sl.command.includes("cairn-statusline")) delete s.statusLine;
  const hooks = s.hooks as Json | undefined;
  if (hooks) {
    for (const k of ["SessionStart", "PreCompact"]) {
      const arr = hooks[k];
      if (Array.isArray(arr)) {
        const kept = (arr as HookEntry[]).filter((e) => !isCairnHook(e));
        if (kept.length) hooks[k] = kept;
        else delete hooks[k];
      }
    }
    if (Object.keys(hooks).length === 0) delete s.hooks;
    else s.hooks = hooks;
  }
  return s;
}

// ---------- pure: Codex config.toml block ----------
export const CODEX_BLOCK_HEADER = "[mcp_servers.cairn]";

export function codexBlock(serverJs: string): string {
  // Forward slashes: a Windows path with backslashes inside a double-quoted TOML *basic* string is
  // invalid TOML (\U, \T, … are illegal escapes) and would corrupt the ENTIRE config.toml - breaking
  // every Codex MCP server, not just cairn. Node accepts forward slashes on Windows.
  const path = serverJs.replace(/\\/g, "/");
  return [
    CODEX_BLOCK_HEADER,
    `command = "node"`,
    `args = ["${path}"]`,
    `startup_timeout_sec = 30`,
    `tool_timeout_sec = 60`,
    "",
  ].join("\n");
}

/** Append the Cairn MCP block to a config.toml (idempotent - no-op if already present). */
export function addCodexBlock(toml: string, serverJs: string): string {
  if (toml.includes(CODEX_BLOCK_HEADER)) return toml;
  const sep = toml.length === 0 ? "" : toml.endsWith("\n") ? "\n" : "\n\n";
  return toml + sep + codexBlock(serverJs);
}

/** Remove the `[mcp_servers.cairn]` table (up to the next table header or EOF). */
export function removeCodexBlock(toml: string): string {
  const out: string[] = [];
  let skip = false;
  for (const line of toml.split("\n")) {
    if (line.trim() === CODEX_BLOCK_HEADER) {
      skip = true;
      continue;
    }
    if (skip && /^\s*\[/.test(line)) skip = false;
    if (!skip) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Project-scope `.mcp.json` silently overrides the user-scope registration. If one registers cairn
 * at a DIFFERENT server.js than ours (e.g. a stale absolute path copied from another machine), return
 * that path so the installer can warn. Returns null when absent or already pointing at us.
 */
export function conflictingProjectMcp(mcpJsonText: string | null, ourServerJs: string): string | null {
  if (!mcpJsonText) return null;
  try {
    const j = JSON.parse(mcpJsonText) as { mcpServers?: Record<string, { args?: unknown }> };
    const entry = j.mcpServers?.cairn;
    if (!entry) return null;
    const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    const target = args.find((a) => a.includes("server.js"));
    return target && target !== ourServerJs ? target : null;
  } catch {
    return null;
  }
}

// ---------- pure: Codex AGENTS.md snippet (fenced, so uninstall removes exactly what install added) ----------
export const CODEX_AGENTS_BEGIN = "<!-- cairn:begin -->";
export const CODEX_AGENTS_END = "<!-- cairn:end -->";

/** Insert OR refresh the fenced Cairn AGENTS snippet. Idempotent for identical content; when the
 *  block already exists with DIFFERENT content (a re-install after the snippet changed), its body is
 *  replaced in place - so updated triggers/notes actually propagate instead of going stale. */
export function addCodexAgents(existing: string, snippet: string): string {
  const block = `${CODEX_AGENTS_BEGIN}\n${snippet.trim()}\n${CODEX_AGENTS_END}`;
  const bi = existing.indexOf(CODEX_AGENTS_BEGIN);
  if (bi !== -1) {
    const ei = existing.indexOf(CODEX_AGENTS_END, bi);
    if (ei !== -1) {
      const before = existing.slice(0, bi);
      const after = existing.slice(ei + CODEX_AGENTS_END.length);
      return (before + block + after).replace(/\n{3,}/g, "\n\n");
    }
  }
  if (existing.trim() === "") return block + "\n";
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + block + "\n";
}

/** Remove the fenced Cairn block. Returns "" when nothing meaningful remains (caller deletes the file). */
export function removeCodexAgents(existing: string): string {
  const begin = existing.indexOf(CODEX_AGENTS_BEGIN);
  if (begin === -1) return existing;
  const endMarker = existing.indexOf(CODEX_AGENTS_END, begin);
  const end = endMarker === -1 ? existing.length : endMarker + CODEX_AGENTS_END.length;
  const cleaned = (existing.slice(0, begin) + existing.slice(end)).replace(/\n{3,}/g, "\n\n");
  return cleaned.trim() === "" ? "" : cleaned;
}

// ---------- side-effecting runner ----------
export interface InstallerOpts {
  home?: string;
  cwd?: string;
  hasCli?: (name: string) => boolean;
  psProfilePaths?: () => string[];
  log?: (msg: string) => void;
  /** UI language for installer output + baked shell strings. Defaults to the resolved runtime language. */
  lang?: Lang;
}

/** Parse `--lang de|en` / `--lang=de` from an argv tail; undefined if absent or invalid. */
export function parseLangArg(argv: string[]): Lang | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lang") return isLang(argv[i + 1]) ? (argv[i + 1] as Lang) : undefined;
    if (a.startsWith("--lang=")) {
      const v = a.slice("--lang=".length);
      return isLang(v) ? v : undefined;
    }
  }
  return undefined;
}

/** Interactive one-shot language prompt (only used when no --lang flag and a TTY is present). */
async function promptLang(): Promise<Lang> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<Lang>((res) => {
    rl.question(t("en").install.langPrompt, (a) => {
      rl.close();
      res(a.trim().toLowerCase().startsWith("d") ? "de" : "en");
    });
  });
}

/**
 * Resolve the language to PERSIST at install time: explicit `--lang` flag wins; else, when a TTY is
 * present, prompt once; else default to 'en' (non-interactive). Injectable seams keep it testable.
 */
export async function resolveInstallLang(
  argv: string[],
  opts: { isTTY?: boolean; prompt?: () => Promise<Lang> } = {},
): Promise<Lang> {
  const flag = parseLangArg(argv);
  if (flag) return flag;
  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (isTTY) return (opts.prompt ?? promptLang)();
  return "en";
}

function defaultHasCli(name: string): boolean {
  // PATH scan (cross-platform incl. Windows PATHEXT) - `which` does not exist on cmd.exe/PowerShell.
  return commandOnPath(name);
}

function readJson(path: string): Json {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Json;
  } catch {
    return {};
  }
}

function writeJson(path: string, obj: Json): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

/** Copy every shipped skill into a host's skills root (`<root>/<name>/SKILL.md`). Idempotent. */
function copySkills(skillsRoot: string, log: (m: string) => void, lang: Lang): void {
  for (const name of SKILL_NAMES) {
    const src = skillSrc(name);
    if (!existsSync(src)) {
      log(t(lang).install.skillSourceMissing({ src }));
      continue;
    }
    const dest = join(skillsRoot, name, "SKILL.md");
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

export function runInstaller(cmd: string, opts: InstallerOpts = {}): void {
  const home = opts.home ?? homedir();
  const hasCli = opts.hasCli ?? defaultHasCli;
  const getPsProfilePaths = opts.psProfilePaths ?? psProfilePaths;
  const log = opts.log ?? ((m: string) => process.stdout.write(m + "\n"));
  const lang: Lang = opts.lang ?? resolveLang();
  const m = t(lang).install;

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    log(m.help);
    return;
  }

  const claudeDir = join(home, ".claude");
  const codexDir = join(home, ".codex");
  const claude = existsSync(claudeDir) || hasCli("claude");
  const codex = existsSync(codexDir) || hasCli("codex");

  if (!claude && !codex) {
    log(m.noHost);
    log(m.noHostHint);
    return;
  }

  if (cmd === "uninstall") {
    uninstall(home, claude, codex, hasCli, log, getPsProfilePaths, lang);
    return;
  }
  install(home, opts.cwd ?? process.cwd(), claude, codex, hasCli, log, getPsProfilePaths, lang);
}

function install(
  home: string,
  cwd: string,
  claude: boolean,
  codex: boolean,
  hasCli: (n: string) => boolean,
  log: (msg: string) => void,
  getPsProfilePaths: () => string[],
  lang: Lang,
): void {
  const m = t(lang).install;
  const dbPath = join(home, ".cairn", "cairn.sqlite");
  log(m.title);

  if (claude) {
    log(m.claudeHeader);
    const settingsPath = join(home, ".claude", "settings.json");
    writeJson(settingsPath, mergeClaudeSettings(readJson(settingsPath), BIN_DIR));
    log(m.settingsOk({ path: settingsPath }));

    copySkills(join(home, ".claude", "skills"), log, lang);
    log(m.skillsClaude);

    // Copy-paste-correct on every shell: path + db quoted (handles spaces like "Claude Meta").
    const manualCmd = `claude mcp add cairn --scope user --env CAIRN_DB="${dbPath}" -- node "${SERVER_JS}"`;
    if (hasCli("claude")) {
      spawnSync("claude", ["mcp", "remove", "cairn", "--scope", "user"], { stdio: "ignore" });
      const r = spawnSync(
        "claude",
        ["mcp", "add", "cairn", "--scope", "user", "--env", `CAIRN_DB=${dbPath}`, "--", "node", SERVER_JS],
        { stdio: "ignore" },
      );
      if (r.status === 0) log(m.mcpRegistered);
      else {
        log(m.mcpAddFailed);
        log(`      ${manualCmd}`);
      }
    } else {
      log(m.mcpManual);
      log(`      ${manualCmd}`);
    }

    // A project-scope .mcp.json overrides user scope - catch a stale/foreign path before it shadows us.
    const projMcp = join(cwd, ".mcp.json");
    const conflict = existsSync(projMcp) ? conflictingProjectMcp(readFileSync(projMcp, "utf8"), SERVER_JS) : null;
    if (conflict) {
      log(m.conflictMcp);
      log(`      ${conflict}`);
      log(m.conflictScope);
      log(m.conflictFix);
    }
  }

  if (codex) {
    log(m.codexHeader);
    const tomlPath = join(home, ".codex", "config.toml");
    const toml = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";
    mkdirSync(dirname(tomlPath), { recursive: true });
    writeFileSync(tomlPath, addCodexBlock(toml, SERVER_JS), "utf8");
    log(m.codexTomlOk({ path: tomlPath }));

    appendCodexAgents(home, log, lang);
    copySkills(join(home, ".agents", "skills"), log, lang);
    log(m.skillsCodex);
  }

  // Shell shortcuts: `cairn window` / `cairn tab` / `status` / `list` (ADR-0009) - cross-platform.
  log(m.shellHeader);
  installShellShortcuts(home, log, getPsProfilePaths, lang);

  log("");
  log(m.langSet({ lang }));
  log(m.doneInstall);
}

function uninstall(
  home: string,
  claude: boolean,
  codex: boolean,
  hasCli: (n: string) => boolean,
  log: (msg: string) => void,
  getPsProfilePaths: () => string[],
  lang: Lang,
): void {
  const m = t(lang).install;
  log(m.uninstallTitle);

  if (claude) {
    const settingsPath = join(home, ".claude", "settings.json");
    if (existsSync(settingsPath)) {
      writeJson(settingsPath, unmergeClaudeSettings(readJson(settingsPath)));
      log(m.settingsCleaned);
    }
    for (const name of SKILL_NAMES) rmSync(join(home, ".claude", "skills", name), { recursive: true, force: true });
    if (hasCli("claude")) {
      spawnSync("claude", ["mcp", "remove", "cairn", "--scope", "user"], { stdio: "ignore" });
      log(m.mcpRemoved);
    } else {
      log(m.mcpRemoveManual);
    }
  }

  if (codex) {
    const tomlPath = join(home, ".codex", "config.toml");
    if (existsSync(tomlPath)) {
      const cleaned = removeCodexBlock(readFileSync(tomlPath, "utf8"));
      if (cleaned.trim() === "") {
        rmSync(tomlPath, { force: true });
        log(m.tomlRemoved);
      } else {
        writeFileSync(tomlPath, cleaned, "utf8");
        log(m.tomlCleaned);
      }
    }
    removeCodexAgentsFile(home, log, lang);
    for (const name of SKILL_NAMES) rmSync(join(home, ".agents", "skills", name), { recursive: true, force: true });
  }

  uninstallShellShortcuts(home, log, getPsProfilePaths, lang);

  log("");
  log(m.doneUninstall);
}

function appendCodexAgents(home: string, log: (m: string) => void, lang: Lang): void {
  if (!existsSync(CODEX_AGENTS_SNIPPET)) return;
  const target = join(home, ".codex", "AGENTS.md");
  const snippet = readFileSync(CODEX_AGENTS_SNIPPET, "utf8");
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  const updated = addCodexAgents(existing, snippet);
  if (updated === existing) return; // already present, no change
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, updated, "utf8");
  log(t(lang).install.agentsAdded);
}

/** Reverse appendCodexAgents: strip the fenced block (delete the file if it was 100% ours).
 *  Falls back to deleting a legacy (pre-fence) file that is exactly the snippet. */
function removeCodexAgentsFile(home: string, log: (m: string) => void, lang: Lang): void {
  const m = t(lang).install;
  const target = join(home, ".codex", "AGENTS.md");
  if (!existsSync(target)) return;
  const existing = readFileSync(target, "utf8");

  if (existing.includes(CODEX_AGENTS_BEGIN)) {
    const cleaned = removeCodexAgents(existing);
    if (cleaned === "") {
      rmSync(target, { force: true });
      log(m.agentsRemoved);
    } else {
      writeFileSync(target, cleaned.endsWith("\n") ? cleaned : cleaned + "\n", "utf8");
      log(m.agentsCleaned);
    }
    return;
  }

  // Legacy (pre-1.1.2) install created the file from empty as 100% snippet.
  if (existsSync(CODEX_AGENTS_SNIPPET) && existing.trim() === readFileSync(CODEX_AGENTS_SNIPPET, "utf8").trim()) {
    rmSync(target, { force: true });
    log(m.agentsRemovedLegacy);
  }
}

// ---------- shell shortcuts (`cairn window` / `tab` / …), ADR-0009 ----------

function shortcutPaths(): ShortcutPaths {
  return {
    watch: join(BIN_DIR, "cairn-codex-watch.js"),
    status: join(BIN_DIR, "cairn-codex-status.js"),
    server: SERVER_JS,
  };
}

/** All-hosts PowerShell profile path(s) for every installed PowerShell - queried via the CLI so
 *  OneDrive-redirected `Documents` is resolved correctly (never hard-coded). */
function psProfilePaths(): string[] {
  const out: string[] = [];
  for (const exe of ["pwsh", "powershell"]) {
    if (!commandOnPath(exe)) continue;
    const r = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", "$PROFILE.CurrentUserAllHosts"], {
      encoding: "utf8",
    });
    const p = r.status === 0 ? (r.stdout ?? "").trim() : "";
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** rc files to wire the POSIX source line into: existing ones, else the platform default. */
function posixRcFiles(home: string): string[] {
  const zshrc = join(home, ".zshrc");
  const bashrc = join(home, ".bashrc");
  const out: string[] = [];
  if (existsSync(zshrc)) out.push(zshrc);
  if (existsSync(bashrc)) out.push(bashrc);
  if (out.length === 0) out.push(process.platform === "darwin" ? zshrc : bashrc);
  return out;
}

function installShellShortcuts(
  home: string,
  log: (msg: string) => void,
  getPsProfilePaths = psProfilePaths,
  lang: Lang = "en",
): void {
  const m = t(lang).install;
  const paths = shortcutPaths();
  if (process.platform === "win32") {
    const profiles = getPsProfilePaths();
    if (profiles.length === 0) {
      log(m.shellNoPs);
      return;
    }
    for (const profile of profiles) {
      const existing = existsSync(profile) ? readFileSync(profile, "utf8") : "";
      mkdirSync(dirname(profile), { recursive: true });
      writeFileSync(profile, mergeMarked(existing, psShortcut(paths, lang)), "utf8");
    }
    log(m.shellPsOk);
    log(m.shellPsHint);
  } else {
    const cairnSh = join(home, ".config", "cairn", "cairn.sh");
    mkdirSync(dirname(cairnSh), { recursive: true });
    writeFileSync(cairnSh, shShortcut(paths, lang) + "\n", "utf8");
    for (const rc of posixRcFiles(home)) {
      const existing = existsSync(rc) ? readFileSync(rc, "utf8") : "";
      writeFileSync(rc, mergeMarked(existing, shSourceInner(cairnSh)), "utf8");
    }
    log(m.shellPosixOk({ path: cairnSh }));
    log(m.shellPosixHint);
  }
}

function uninstallShellShortcuts(
  home: string,
  log: (msg: string) => void,
  getPsProfilePaths = psProfilePaths,
  lang: Lang = "en",
): void {
  let touched = false;
  if (process.platform === "win32") {
    for (const profile of getPsProfilePaths()) {
      if (!existsSync(profile)) continue;
      const before = readFileSync(profile, "utf8");
      const cleaned = unmergeMarked(before);
      if (cleaned !== before) {
        writeFileSync(profile, cleaned, "utf8");
        touched = true;
      }
    }
  } else {
    const cairnSh = join(home, ".config", "cairn", "cairn.sh");
    if (existsSync(cairnSh)) {
      rmSync(cairnSh, { force: true });
      touched = true;
    }
    for (const rc of [join(home, ".zshrc"), join(home, ".bashrc")]) {
      if (!existsSync(rc)) continue;
      const before = readFileSync(rc, "utf8");
      const cleaned = unmergeMarked(before);
      if (cleaned !== before) {
        writeFileSync(rc, cleaned, "utf8");
        touched = true;
      }
    }
  }
  if (touched) log(t(lang).install.shellRemoved);
}
