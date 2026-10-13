import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import type { ExecFn } from "../core/bridge.js";
import { SEVEN_BUCKET_PROMPT } from "../core/prompts.js";
import { messages } from "../i18n/messages.js";
import { makeAccountCompactor, compactionPromptSha256, CALIB_DIRECTIVE_LANG } from "./account-compactor.js";

/* ADR-0013: a calibration artifact records the hash of the compaction system prompt, so --pool never mixes
   runs of different prompts. The hash must be of what the CLI actually receives. */

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const BRIEF = "1) DECISIONS " + "x ".repeat(10);

describe("compactionPromptSha256", () => {
  it("hashes the 7-bucket prompt plus the brief-only directive of the directive language", () => {
    expect(CALIB_DIRECTIVE_LANG).toBe("en");
    expect(compactionPromptSha256()).toBe(sha(`${SEVEN_BUCKET_PROMPT}\n\n${messages.en.prompts.briefOnly}`));
    expect(compactionPromptSha256("S")).toBe(sha(`S\n\n${messages.en.prompts.briefOnly}`));
  });

  it("is the hash of the system prompt claude receives", async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: JSON.stringify({ result: BRIEF }), stderr: "", code: 0 }));
    await makeAccountCompactor({ execFn: exec, minBriefTokens: 0 })({ modelId: "claude-opus-5-5@high", maskedProbe: "P", prompt: SEVEN_BUCKET_PROMPT });
    const args = exec.mock.calls[0][1];
    expect(sha(args[args.indexOf("--system-prompt") + 1])).toBe(compactionPromptSha256());
  });

  it("is the hash of the system part codex receives on stdin", async () => {
    const exec = vi.fn<ExecFn>(async () => ({
      stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: BRIEF } }),
      stderr: "",
      code: 0,
    }));
    await makeAccountCompactor({ execFn: exec, minBriefTokens: 0 })({ modelId: "gpt-6.1-sol@high", maskedProbe: "PROBE", prompt: SEVEN_BUCKET_PROMPT });
    const stdin = exec.mock.calls[0][2]!.stdin!;
    expect(stdin.endsWith("\n\nPROBE")).toBe(true);
    expect(sha(stdin.slice(0, -"\n\nPROBE".length))).toBe(compactionPromptSha256());
  });

  it("pins the 2.0.0 prompt: a change needs a new golden run before it pools or replaces the profiles", () => {
    expect(compactionPromptSha256()).toBe("e325e31b66c049badcf5d88329dbd48cba506981668ff9f1d04b9332ba8c228b");
  });
});
