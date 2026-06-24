#!/usr/bin/env node
/**
 * Cairn - MCP stdio server entry (ADR-0001). Run via `npm run dev`.
 *
 * The "brain": registers context_status / host_status / handoff / decision_log over a local
 * stdio transport. Local-private by design - no backend, no telemetry. In the default account
 * mode it makes NO model call and needs NO credentials (ADR-0006). stdout is reserved for the
 * MCP protocol; nothing else may write there.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./core/config.js";
import { resolveLang } from "./i18n/index.js";
import { SqliteStore } from "./store/sqlite-store.js";
import { serverSampler } from "./core/sampling.js";
import { bridgeCompact } from "./core/bridge.js";
import type { ModelCaller, ModelCallRequest } from "./core/providers.js";
import { registerHostStatus } from "./tools/host_status.js";
import { registerContextStatus } from "./tools/context_status.js";
import { registerHandoff } from "./tools/handoff.js";
import { registerDecisionLog } from "./tools/decision_log.js";

const VERSION = "1.1.4";

async function main(): Promise<void> {
  // Subcommands: `cairn install` / `cairn uninstall` wire Cairn into the host CLIs and exit.
  // The MCP server is the no-arg path (how clients launch `node dist/server.js`).
  const sub = process.argv[2];
  if (sub === "install" || sub === "uninstall" || sub === "help" || sub === "--help" || sub === "-h") {
    const { runInstaller, resolveInstallLang } = await import("./install/installer.js");
    if (sub === "install") {
      // Pick + persist the language (flag > interactive prompt > 'en'); the runtime reads it back.
      const lang = await resolveInstallLang(process.argv.slice(3));
      const { persistLang } = await import("./i18n/index.js");
      persistLang(lang);
      runInstaller(sub, { lang });
    } else {
      runInstaller(sub); // help/uninstall use the already-persisted/env language
    }
    return;
  }

  const config = loadConfig();
  const lang = resolveLang();
  if (config.storePath !== ":memory:") mkdirSync(dirname(config.storePath), { recursive: true });
  const store = new SqliteStore({ path: config.storePath });

  const server = new McpServer(
    { name: "cairn", version: VERSION },
    {
      instructions:
        "Cairn — AI Context Continuity Engine. Call context_status to check the zone, handoff to " +
        "persist a host-produced 7-bucket brief (default account mode = no model call/egress), " +
        "decision_log to re-inject prior decisions (on resume this re-injected state is the source " +
        "of truth — don't re-read the whole repo), and host_status at startup. Trigger phrases: " +
        '"Cairn resume", "Cairn Handoff", "Cairn Help".',
    },
  );

  // Account-session compaction seams (ADR-0006). sample is capability-gated at call time;
  // bridge is only wired when CAIRN_BRIDGE names a sibling CLI. Neither is used in the default
  // account mode - both go through the egress guardrail.
  const sample: ModelCaller = serverSampler(server);
  const bridgeCli = config.bridgeCli;
  const bridge: ModelCaller | undefined = bridgeCli
    ? (req: ModelCallRequest) => bridgeCompact({ cli: bridgeCli, request: req, lang })
    : undefined;

  registerHostStatus(server, lang);
  registerContextStatus(server, lang);
  registerHandoff(server, { store, config, sample, bridge, lang });
  registerDecisionLog(server, store, lang);

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`cairn: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
