/**
 * Cairn - best-effort host-CLI detection for the `host_status` tool (ADR-0006).
 *
 * Installed CLIs are detected reliably (PATH lookup). Login status is BEST-EFFORT only
 * (config-file presence heuristic) and is labeled as such. The active session model cannot
 * be read from the MCP side in general; we surface it only when the host passes it in
 * (e.g. via env), otherwise "unknown". All OS edges are injected so this is unit-testable.
 */

import { join } from "node:path";
import type { Env } from "./env.js";
import { t, type Lang } from "../i18n/index.js";

export type HostCli = "claude" | "codex";

export interface HostProbe {
  /** True if `cmd` resolves on PATH (real impl: `command -v`). */
  commandExists(cmd: string): boolean;
  /** True if a file exists (real impl: fs.existsSync). */
  fileExists(path: string): boolean;
  homedir(): string;
}

export interface HostCliStatus {
  cli: HostCli;
  installed: boolean;
  /** best-effort: true/false from config-file presence, or "unknown" when not probed. */
  loggedIn: boolean | "unknown";
  loginEvidence?: string;
  activeModel?: string;
}

export interface HostStatusReport {
  clis: HostCliStatus[];
  recommendation: string;
  loginDetectionNote: string;
}

const LOGIN_EVIDENCE: Record<HostCli, (home: string) => string[]> = {
  claude: (home) => [join(home, ".claude.json"), join(home, ".claude", ".credentials.json")],
  codex: (home) => [join(home, ".codex", "auth.json"), join(home, ".codex", "config.toml")],
};

const ALT_MODEL: Record<HostCli, string> = {
  claude: "Claude Opus 4.8",
  codex: "GPT-5.5",
};

export function detectHostStatus(probe: HostProbe, lang: Lang = "en", env: Env = process.env): HostStatusReport {
  const home = probe.homedir();
  const clis: HostCliStatus[] = (["claude", "codex"] as HostCli[]).map((cli) => {
    const installed = probe.commandExists(cli);
    let loggedIn: boolean | "unknown" = "unknown";
    let loginEvidence: string | undefined;
    if (installed) {
      const hit = LOGIN_EVIDENCE[cli](home).find((p) => probe.fileExists(p));
      loggedIn = hit ? true : false;
      loginEvidence = hit;
    }
    const activeModel = cli === "claude" ? env.CAIRN_HOST_MODEL : env.CAIRN_CODEX_MODEL;
    return { cli, installed, loggedIn, loginEvidence, activeModel: activeModel || undefined };
  });

  return {
    clis,
    recommendation: buildRecommendation(clis, lang),
    loginDetectionNote: t(lang).hostStatus.loginNote,
  };
}

function buildRecommendation(clis: HostCliStatus[], lang: Lang): string {
  const m = t(lang).hostStatus;
  const by = (c: HostCli) => clis.find((x) => x.cli === c)!;
  const claude = by("claude");
  const codex = by("codex");
  const parts: string[] = [];

  for (const s of [claude, codex]) {
    if (!s.installed) {
      parts.push(m.notFoundRec({ cli: s.cli, altModel: ALT_MODEL[s.cli] }));
    } else if (s.loggedIn === true) {
      parts.push(m.loggedInRec({ cli: s.cli, model: s.activeModel }));
    } else {
      parts.push(m.notLoggedInRec({ cli: s.cli }));
    }
  }

  const anyReady = clis.some((s) => s.installed && s.loggedIn === true);
  if (!anyReady) parts.push(m.noReadyHost);
  return parts.join(" ");
}
