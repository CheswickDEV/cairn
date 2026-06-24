/**
 * Cairn - runtime config + egress modes (ADR-0006).
 *
 * Default is ACCOUNT mode: the host agent compacts in-session on the user's own
 * subscription; the Cairn server makes NO model call and needs NO credentials. Optional
 * egress modes (sampling / bridge / api) are off unless the operator explicitly enables
 * them AND configures an endpoint. Nothing here holds secrets - credentials are read from
 * env at call time via `apiKeyEnv`.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Env } from "./env.js";

export type CompactionMode = "account" | "sampling" | "bridge" | "api";

export interface EndpointConfig {
  provider: "anthropic" | "openai" | "gemini";
  /** Base URL of the configured endpoint (the ONLY place egress may go). */
  baseUrl: string;
  /** Name of the env var holding the API key (read at call time, never stored). */
  apiKeyEnv?: string;
  /** Default model id for this endpoint. */
  model?: string;
}

export interface CairnConfig {
  /** Modes the operator has explicitly enabled. Always includes "account". */
  enabledModes: CompactionMode[];
  /** Configured egress endpoints, keyed by name. Empty in the default install. */
  endpoints: Record<string, EndpointConfig>;
  /** Which sibling CLI to bridge to in `bridge` mode (CAIRN_BRIDGE=claude|codex); undefined = off. */
  bridgeCli?: "claude" | "codex";
  /** SQLite file path for the decision/evidence store. */
  storePath: string;
}

/**
 * Build config from the environment. The default (no relevant env set) is account-only with
 * zero endpoints - i.e. zero possible egress. Optional modes require BOTH an explicit
 * `CAIRN_ENABLE_MODES` entry and a configured `CAIRN_ENDPOINT_*` triple.
 */
export function loadConfig(env: Env = process.env): CairnConfig {
  const enabledModes: CompactionMode[] = ["account"];
  const requested = (env.CAIRN_ENABLE_MODES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const m of requested) {
    if ((m === "sampling" || m === "bridge" || m === "api") && !enabledModes.includes(m)) {
      enabledModes.push(m);
    }
  }

  // Endpoints declared as: CAIRN_ENDPOINT_<NAME>=provider|baseUrl|apiKeyEnv|model
  const endpoints: Record<string, EndpointConfig> = {};
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith("CAIRN_ENDPOINT_") || !raw) continue;
    const name = key.slice("CAIRN_ENDPOINT_".length).toLowerCase();
    const [provider, baseUrl, apiKeyEnv, model] = raw.split("|").map((s) => s.trim());
    if ((provider === "anthropic" || provider === "openai" || provider === "gemini") && baseUrl) {
      endpoints[name] = {
        provider,
        baseUrl,
        apiKeyEnv: apiKeyEnv || undefined,
        model: model || undefined,
      };
    }
  }

  const storePath = env.CAIRN_DB ?? join(homedir(), ".cairn", "cairn.sqlite");
  const bridge = env.CAIRN_BRIDGE === "claude" || env.CAIRN_BRIDGE === "codex" ? env.CAIRN_BRIDGE : undefined;

  return { enabledModes, endpoints, bridgeCli: bridge, storePath };
}
