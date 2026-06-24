/**
 * `host_status` tool (ADR-0006) - readOnly, startup check.
 *
 * Detects installed host CLIs (claude/codex) reliably; login + active model are best-effort
 * and labeled as such. Surfaces a sign-in overview + recommendation.
 */

import { z } from "zod";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectHostStatus, type HostProbe, type HostStatusReport } from "../core/host-detect.js";
import { commandOnPath } from "../core/platform.js";
import { t, type Lang } from "../i18n/index.js";

/** Non-shell PATH lookup (no `sh -c`, no subprocess); cross-platform incl. Windows PATHEXT. */
function onPath(cmd: string): boolean {
  return commandOnPath(cmd);
}

/** Real OS-bound probe used by the running server. */
export function realHostProbe(): HostProbe {
  return {
    commandExists: onPath,
    fileExists: (p) => existsSync(p),
    homedir,
  };
}

function formatReport(r: HostStatusReport, lang: Lang): string {
  const m = t(lang).hostStatus;
  const lines = r.clis.map((c) => {
    const login = c.loggedIn === "unknown" ? m.loginUnknown : c.loggedIn ? m.loggedIn : m.noLogin;
    const model = c.activeModel ? m.modelSuffix({ model: c.activeModel }) : "";
    return `• ${c.cli}: ${c.installed ? m.installed : m.notFound}${c.installed ? `, ${login}${model}` : ""}`;
  });
  return [m.overviewTitle, ...lines, ``, `${m.recommendationLabel}: ${r.recommendation}`, ``, `(${r.loginDetectionNote})`].join("\n");
}

export function registerHostStatus(
  server: McpServer,
  lang: Lang = "en",
  probe: HostProbe = realHostProbe(),
): void {
  server.registerTool(
    "host_status",
    {
      title: "Host status",
      description:
        "Detects installed host CLIs (claude/codex), best-effort login + active session model, and " +
        "prints a sign-in overview with a recommendation. Login detection is best-effort.",
      inputSchema: {},
      outputSchema: {
        clis: z.array(
          z.object({
            cli: z.enum(["claude", "codex"]),
            installed: z.boolean(),
            loggedIn: z.union([z.boolean(), z.literal("unknown")]),
            activeModel: z.string().optional(),
            loginEvidence: z.string().optional(),
          }),
        ),
        recommendation: z.string(),
        loginDetectionNote: z.string(),
      },
      annotations: { title: "Host status", readOnlyHint: true },
    },
    async () => {
      const report = detectHostStatus(probe, lang);
      return { content: [{ type: "text", text: formatReport(report, lang) }], structuredContent: { ...report } };
    },
  );
}
