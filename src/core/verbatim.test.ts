import { describe, it, expect } from "vitest";
import { freezeVerbatim, restoreVerbatim, missingVerbatim, MARKER_PREFIX } from "./verbatim.js";

describe("freezeVerbatim / restoreVerbatim", () => {
  it("round-trips a fixture with code blocks, inline code, IDs and numbers byte-exact", () => {
    const original = [
      "We decided to keep the scope `read:logs` and the id below.",
      "",
      "```ts",
      "const API_KEY_SCOPE = 'read:logs';",
      "const id = 42;          // exact: surfaceCap=200000",
      "const pi = 3.14159;",
      "```",
      "",
      "See error string `ECONN_RESET_17` and url https://example.test/v1.",
    ].join("\n");

    const frozen = freezeVerbatim(original);
    // Protected spans are masked out of the prose.
    expect(frozen.masked).not.toContain("API_KEY_SCOPE");
    expect(frozen.masked).toContain(MARKER_PREFIX);
    // Byte-exact restoration.
    const restored = restoreVerbatim(frozen.masked, frozen.holds);
    expect(restored).toBe(original);
    expect(restored.length).toBe(original.length);
  });

  it("masks fenced blocks and inline code as separate holds", () => {
    const text = "Run `npm test` then:\n```\nconst id=7;\n```\ndone";
    const { masked, holds } = freezeVerbatim(text);
    expect(holds.length).toBe(2); // one fence + one inline
    expect(masked).toBe(`Run ${MARKER_PREFIX}1]] then:\n${MARKER_PREFIX}0]]\ndone`);
    expect(restoreVerbatim(masked, holds)).toBe(text);
  });

  it("protects caller-flagged exact spans (values/IDs), all occurrences", () => {
    const text = "token ABC-123 here and ABC-123 again";
    const { masked, holds } = freezeVerbatim(text, ["ABC-123"]);
    expect(masked).not.toContain("ABC-123");
    expect(holds).toHaveLength(1);
    expect(restoreVerbatim(masked, holds)).toBe(text);
  });

  it("a marker the model dropped stays dropped (the rest still restores)", () => {
    const text = "keep `A` drop `B`";
    const { masked, holds } = freezeVerbatim(text);
    // Simulate the model omitting the second marker entirely.
    const modelOutput = masked.replace(`${MARKER_PREFIX}1]]`, "").trimEnd();
    const restored = restoreVerbatim(modelOutput, holds);
    expect(restored).toContain("`A`");
    expect(restored).not.toContain("`B`");
  });
});

describe("missingVerbatim", () => {
  it("reports required spans the brief failed to preserve byte-exact", () => {
    const brief = "Kept scope read:logs but rephrased the id.";
    expect(missingVerbatim(brief, ["read:logs"])).toEqual([]);
    expect(missingVerbatim(brief, ["read:logs", "id=42"])).toEqual(["id=42"]);
  });
});
