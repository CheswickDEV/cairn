/**
 * Cairn - MCP Sampling compaction (ADR-0006 mode 2).
 *
 * Asks the connected MCP client (e.g. Claude Code, which supports sampling) to run the
 * completion via `sampling/createMessage`. The completion executes on the USER's account/
 * subscription inside the client - Cairn holds no credentials. Gated by the client actually
 * advertising the `sampling` capability; otherwise it refuses (no silent egress).
 *
 * Limit (ADR-0012): `sampling/createMessage` has no effort field, so this mode cannot enforce the
 * `high` effort floor - the client's model and effort defaults apply. (MCP spec 2026-07-28 deprecates
 * sampling.) Use the bridge or API mode when the effort matters.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EgressNotConfiguredError, type ModelCaller } from "./providers.js";

/** Build a ModelCaller backed by the client's sampling capability. Checks capability at call
 *  time (capabilities are only known after the client has initialized). */
export function serverSampler(server: McpServer): ModelCaller {
  return async (req) => {
    const caps = server.server.getClientCapabilities?.();
    if (!caps?.sampling) {
      throw new EgressNotConfiguredError("client does not advertise MCP sampling capability");
    }
    const res = await server.server.createMessage({
      messages: [{ role: "user", content: { type: "text", text: req.prompt } }],
      ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
      maxTokens: req.maxTokens,
      // The client picks the model; Cairn can only name its selection as a hint (ADR-0012).
      ...(req.model ? { modelPreferences: { hints: [{ name: req.model }] } } : {}),
    });
    const text = res.content.type === "text" ? res.content.text : "";
    const finishReason = res.stopReason ?? "unknown";
    return { text, truncated: finishReason === "maxTokens", finishReason };
  };
}
