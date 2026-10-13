import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runHandoff, registerHandoff, type HandoffInput } from "./handoff.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { loadConfig } from "../core/config.js";
import type { ModelCaller } from "../core/providers.js";

/* Quote check in the optional modes (ADR-0013): a quote the source does not hold word for word is marked as
   derived in the stored brief; account mode has no source and stores the brief as written. */

const store = () => new SqliteStore({ path: ":memory:" });
const host = { modelId: "claude-opus-5-5" };
const bridgeConfig = loadConfig({ CAIRN_ENABLE_MODES: "bridge,sampling", CAIRN_BRIDGE: "claude" });
const SOURCE = "USER: Go with (a) now, keep (b) as a follow-up ticket. Do not switch to Postgres.";
const BRIEF = [
  "4) CONSTRAINTS",
  '- "Do not switch to Postgres." (user)',
  '- "Option (b) must not touch the worker protocol"',
].join("\n");
const answering = (text: string) => vi.fn<ModelCaller>(async () => ({ text, truncated: false, finishReason: "success" }));

describe("handoff — quote check in the optional modes (ADR-0013)", () => {
  it("bridge: reports a quote the source lacks and marks it in the stored brief", async () => {
    const s = store();
    const r = await runHandoff(
      { brief: "", source: SOURCE, host, sourceZone: "red", mode: "bridge" },
      { store: s, config: bridgeConfig, bridge: answering(BRIEF) },
    );
    expect(r.unverifiedQuotes).toEqual(["Option (b) must not touch the worker protocol"]);
    expect(s.getDecision(r.storedDecisionId)!.rationale).toBe(
      `${BRIEF}\n\n[Cairn check] Not found word for word in the source, so treat as derived: "Option (b) must not touch the worker protocol"`,
    );
  });

  it("sampling: checks against the brief when no source is given; DE note; several quotes joined", async () => {
    const s = store();
    const brief = '- "Do not switch to Postgres."\n- "one two three"\n- "four five six"';
    const r = await runHandoff(
      { brief: "Do not switch to Postgres.", host, sourceZone: "red", mode: "sampling" },
      { store: s, config: bridgeConfig, sample: answering(brief), lang: "de" },
    );
    expect(r.unverifiedQuotes).toEqual(["one two three", "four five six"]);
    expect(s.getDecision(r.storedDecisionId)!.rationale).toBe(
      `${brief}\n\n[Cairn-Prüfung] Nicht wörtlich in der Quelle gefunden, daher als abgeleitet behandeln: "one two three"; "four five six"`,
    );
  });

  it("stores the brief unchanged when every quote is in the source", async () => {
    const s = store();
    const brief = '- "Do not switch to Postgres." (user)';
    const r = await runHandoff(
      { brief: "", source: SOURCE, host, sourceZone: "red", mode: "bridge" },
      { store: s, config: bridgeConfig, bridge: answering(brief) },
    );
    expect(r.unverifiedQuotes).toEqual([]);
    expect(s.getDecision(r.storedDecisionId)!.rationale).toBe(brief);
  });

  it("required verbatim is judged on the model's brief, before the note is appended", async () => {
    const r = await runHandoff(
      { brief: "", source: SOURCE, host, sourceZone: "red", mode: "bridge", requiredVerbatim: ["one two three", "Not found word for word"] },
      { store: store(), config: bridgeConfig, bridge: answering('x "one two three" y') },
    );
    expect(r.unverifiedQuotes).toEqual(["one two three"]);
    // The brief holds the quote; only the appended note holds the note's text.
    expect(r.missingRequired).toEqual(["Not found word for word"]);
  });

  it("checks the restored brief against the source as given, not against its masked form", async () => {
    // `npm test` is masked behind a hold marker for the model call; the quote holds it again after the restore.
    const source = "Sara: run `npm test` before every merge, no exceptions.";
    const echo = vi.fn<ModelCaller>(async (req) => ({
      text: `4) CONSTRAINTS\n- "${req.prompt.slice("Sara: ".length, req.prompt.indexOf(","))}" (Sara)`,
      truncated: false,
      finishReason: "success",
    }));
    const s = store();
    const r = await runHandoff({ brief: "", source, host, sourceZone: "red", mode: "bridge" }, { store: s, config: bridgeConfig, bridge: echo });
    expect(echo.mock.calls[0][0].prompt).toContain("[[CAIRN-HOLD-0]]");
    expect(s.getDecision(r.storedDecisionId)!.rationale).toBe('4) CONSTRAINTS\n- "run `npm test` before every merge" (Sara)');
    expect(r.unverifiedQuotes).toEqual([]);
  });

  it("a stored brief with its note, later part of the source, does not clear the note on the next handoff", async () => {
    const s = store();
    const first = await runHandoff(
      { brief: "", source: SOURCE, host, sourceZone: "red", mode: "bridge" },
      { store: s, config: bridgeConfig, bridge: answering(BRIEF) },
    );
    const resumed = s.getDecision(first.storedDecisionId)!.rationale;
    const second = await runHandoff(
      { brief: "", source: `${SOURCE}\n\nCairn resume:\n${resumed}\n\nUSER: continue.`, host, sourceZone: "red", mode: "bridge" },
      { store: s, config: bridgeConfig, bridge: answering(BRIEF) },
    );
    expect(second.unverifiedQuotes).toEqual(["Option (b) must not touch the worker protocol"]);
    expect(s.getDecision(second.storedDecisionId)!.rationale).toBe(resumed);
  });

  it("account mode: no check, no field, the host brief stored as written", async () => {
    const s = store();
    const r = await runHandoff({ brief: BRIEF, source: SOURCE, host, sourceZone: "red" }, { store: s, config: loadConfig({}) });
    expect(r).not.toHaveProperty("unverifiedQuotes");
    expect(s.getDecision(r.storedDecisionId)!.rationale).toBe(BRIEF);
  });
});

describe("handoff tool text — quote warning", () => {
  const toolText = async (brief: string) => {
    let handler: ((args: unknown) => Promise<{ content: Array<{ text: string }>; structuredContent: Record<string, unknown> }>) | undefined;
    const server = { registerTool: (_n: string, _d: unknown, h: typeof handler) => (handler = h) } as unknown as McpServer;
    registerHandoff(server, { store: store(), config: bridgeConfig, bridge: answering(brief) });
    const input: HandoffInput = { brief: "", source: SOURCE, host, sourceZone: "red", mode: "bridge" };
    return handler!(input);
  };

  it("names the unverified quotes", async () => {
    const out = await toolText(BRIEF);
    expect(out.content[0].text).toContain(
      '⚠ Quotes not found word for word in the source, noted at the end of the stored brief: "Option (b) must not touch the worker protocol"',
    );
    expect(out.structuredContent.unverifiedQuotes).toEqual(["Option (b) must not touch the worker protocol"]);
  });

  it("has no warning when every quote is found", async () => {
    expect((await toolText('"Do not switch to Postgres."')).content[0].text).not.toContain("⚠ Quotes");
  });
});
