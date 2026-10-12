import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeProjectSlug,
  locateClaudeTranscript,
  renderClaudeTranscript,
  renderCodexRollout,
  readSessionTranscript,
} from "./transcript.js";

/* ADR-0012: the session transcript for the opt-in automatic compaction in account mode. */

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

describe("Claude Code transcript lookup", () => {
  it("names the project directory like Claude Code: every non-alphanumeric character becomes '-'", () => {
    expect(claudeProjectSlug("/opt/claude/cairn")).toBe("-opt-claude-cairn");
    expect(claudeProjectSlug("/home/a.b/my repo")).toBe("-home-a-b-my-repo");
  });

  it("finds <config>/projects/<slug>/<session>.jsonl from CLAUDE_PROJECT_DIR + CLAUDE_CODE_SESSION_ID", () => {
    const home = mkdtempSync(join(tmpdir(), "cairn-tr-"));
    const dir = join(home, ".claude", "projects", "-work-repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "abc-123.jsonl"), "");
    const env = { CLAUDE_PROJECT_DIR: "/work/repo", CLAUDE_CODE_SESSION_ID: "abc-123" };
    expect(locateClaudeTranscript(env, home)).toBe(join(dir, "abc-123.jsonl"));
    expect(locateClaudeTranscript({ ...env, CLAUDE_CODE_SESSION_ID: "other" }, home)).toBeUndefined();
    expect(locateClaudeTranscript({ CLAUDE_PROJECT_DIR: "/work/repo" }, home)).toBeUndefined();
    // No path escape, even when the escaped target exists.
    writeFileSync(join(home, ".claude", "projects", "escape.jsonl"), "");
    expect(locateClaudeTranscript({ ...env, CLAUDE_CODE_SESSION_ID: "../escape" }, home)).toBeUndefined();
    const cfg = join(home, "cfg");
    mkdirSync(join(cfg, "projects", "-work-repo"), { recursive: true });
    writeFileSync(join(cfg, "projects", "-work-repo", "abc-123.jsonl"), "");
    expect(locateClaudeTranscript({ ...env, CLAUDE_CONFIG_DIR: cfg }, home)).toBe(join(cfg, "projects", "-work-repo", "abc-123.jsonl"));
  });

  it("reads nothing when the transcript cannot be found", () => {
    expect(readSessionTranscript("claude", {})).toBeUndefined();
  });
});

describe("renderClaudeTranscript", () => {
  it("follows the active branch only: a rewound branch, side chains and meta messages stay out", () => {
    const text = renderClaudeTranscript(
      jsonl([
        { type: "mode", mode: "x" },
        { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "Use PostgreSQL. <system-reminder>harness noise</system-reminder>" } },
        {
          type: "assistant", uuid: "a1", parentUuid: "u1",
          message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "Checking." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
        },
        { type: "user", uuid: "u2", parentUuid: "a1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "README.md" }] }] } },
        { type: "assistant", uuid: "a2", parentUuid: "u2", message: { role: "assistant", content: [{ type: "text", text: "ABANDONED BRANCH" }] } },
        { type: "user", uuid: "u3", parentUuid: "u2", isMeta: true, message: { role: "user", content: "injected skill text" } },
        { type: "user", uuid: "u4", parentUuid: "u3", message: { role: "user", content: "Rewound: use MySQL instead?" } },
        { type: "assistant", uuid: "s1", parentUuid: "u4", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "SUBAGENT" }] } },
        { type: "assistant", uuid: "a3", parentUuid: "u4", message: { role: "assistant", content: [{ type: "text", text: "No, PostgreSQL stays." }] } },
        { type: "attachment", uuid: "x1", parentUuid: "a3", attachment: {} },
      ]),
    );
    expect(text).toBe(
      [
        "USER: Use PostgreSQL.",
        "ASSISTANT: Checking.",
        'TOOL CALL Bash: {"command":"ls"}',
        "TOOL RESULT: README.md",
        "USER: Rewound: use MySQL instead?",
        "ASSISTANT: No, PostgreSQL stays.",
      ].join("\n\n"),
    );
  });

  it("leaves out side-chain entries, also where they sit on the path or end the file", () => {
    const text = renderClaudeTranscript(
      jsonl([
        { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "go" } },
        { type: "assistant", uuid: "s1", parentUuid: "u1", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "SUBAGENT ON PATH" }] } },
        { type: "assistant", uuid: "a1", parentUuid: "s1", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
        { type: "assistant", uuid: "s2", parentUuid: "a1", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "SUBAGENT LAST" }] } },
      ]),
    );
    expect(text).toBe(["USER: go", "ASSISTANT: done"].join("\n\n"));
  });

  it("starts after the last compact boundary, with the compaction summary as earlier context", () => {
    const text = renderClaudeTranscript(
      jsonl([
        { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "old turn" } },
        { type: "system", uuid: "b1", parentUuid: "u1", subtype: "compact_boundary" },
        { type: "user", uuid: "u2", parentUuid: "b1", isCompactSummary: true, message: { role: "user", content: "Summary: PostgreSQL chosen." } },
        { type: "user", uuid: "u3", parentUuid: "u2", message: { role: "user", content: "next" } },
        { type: "assistant", uuid: "a1", parentUuid: "u3", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
      ]),
    );
    expect(text).toBe(["EARLIER CONTEXT (compacted): Summary: PostgreSQL chosen.", "USER: next", "ASSISTANT: ok"].join("\n\n"));
  });

  it("ignores a torn last line and returns '' without any message", () => {
    expect(renderClaudeTranscript('{"type":"mode"}\n{"type":"user","uuid":"u1","parentUuid":null,"message":{"role":"user","content":"hi"}}\n{"type":"assis')).toBe("USER: hi");
    expect(renderClaudeTranscript("")).toBe("");
  });
});

describe("renderCodexRollout", () => {
  it("keeps user/assistant messages and tool calls after the last compaction; Codex's own context stays out", () => {
    const text = renderCodexRollout(
      jsonl([
        { type: "session_meta", payload: { id: "s", cwd: "/w" } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "old" }] } },
        { type: "compacted", payload: { message: "Summary: Redis is the queue." } },
        { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "base instructions" }] } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /w\nrules" }] } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a retry." }] } },
        { type: "response_item", payload: { type: "reasoning", summary: [] } },
        { type: "response_item", payload: { type: "function_call", name: "shell", arguments: '{"cmd":"rg retry"}' } },
        { type: "response_item", payload: { type: "function_call_output", output: "src/x.ts:1" } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
        { type: "event_msg", payload: { type: "token_count" } },
      ]),
    );
    expect(text).toBe(
      [
        "EARLIER CONTEXT (compacted): Summary: Redis is the queue.",
        "USER: Add a retry.",
        'TOOL CALL shell: {"cmd":"rg retry"}',
        "TOOL RESULT: src/x.ts:1",
        "ASSISTANT: Done.",
      ].join("\n\n"),
    );
  });
});
