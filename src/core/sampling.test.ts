import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serverSampler } from "./sampling.js";
import { EgressNotConfiguredError } from "./providers.js";

interface FakeOpts {
  caps?: unknown;
  createMessage?: (params: unknown) => Promise<unknown>;
}
function fakeServer(opts: FakeOpts): McpServer {
  return {
    server: {
      getClientCapabilities: () => opts.caps,
      createMessage: opts.createMessage ?? (async () => ({ content: { type: "text", text: "" } })),
    },
  } as unknown as McpServer;
}

const req = { prompt: "compact this", maxTokens: 1024, model: "m" };

describe("serverSampler", () => {
  it("refuses when the client does not advertise the sampling capability", async () => {
    const sample = serverSampler(fakeServer({ caps: undefined }));
    await expect(sample(req)).rejects.toBeInstanceOf(EgressNotConfiguredError);
  });

  it("requests a completion via createMessage and returns its text", async () => {
    const createMessage = vi.fn(async (_params: unknown) => ({
      content: { type: "text", text: "SAMPLED BRIEF" },
      stopReason: "endTurn",
      model: "claude-opus-4-8",
      role: "assistant",
    }));
    const sample = serverSampler(fakeServer({ caps: { sampling: {} }, createMessage }));
    const r = await sample({ ...req, systemPrompt: "SYS" });
    expect(createMessage).toHaveBeenCalledTimes(1);
    const params = createMessage.mock.calls[0][0] as { messages: unknown[]; systemPrompt?: string; maxTokens: number };
    expect(params.systemPrompt).toBe("SYS");
    expect(params.maxTokens).toBe(1024);
    expect(r.text).toBe("SAMPLED BRIEF");
    expect(r.truncated).toBe(false);
  });

  it("flags stopReason=maxTokens as truncated", async () => {
    const sample = serverSampler(
      fakeServer({
        caps: { sampling: {} },
        createMessage: async () => ({ content: { type: "text", text: "cut" }, stopReason: "maxTokens" }),
      }),
    );
    const r = await sample(req);
    expect(r.truncated).toBe(true);
  });
});
