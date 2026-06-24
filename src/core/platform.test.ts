import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandOnPath } from "./platform.js";

function withBin(file: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cairn-path-"));
  try {
    writeFileSync(join(dir, file), "#!/bin/sh\n", "utf8");
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("commandOnPath", () => {
  it("finds a bare executable on POSIX", () => {
    withBin("mycli", (dir) => {
      expect(commandOnPath("mycli", { env: { PATH: dir }, platform: "linux" })).toBe(true);
      expect(commandOnPath("nope", { env: { PATH: dir }, platform: "linux" })).toBe(false);
    });
  });

  it("finds a Windows .cmd shim via PATHEXT (the npm-install case)", () => {
    withBin("claude.cmd", (dir) => {
      const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
      expect(commandOnPath("claude", { env, platform: "win32" })).toBe(true);
      // POSIX semantics (no extensions) must NOT match a bare-named lookup against claude.cmd
      expect(commandOnPath("claude", { env: { PATH: dir }, platform: "linux" })).toBe(false);
    });
  });

  it("splits PATH with the platform-correct delimiter and handles empty PATH", () => {
    withBin("tool.exe", (dir) => {
      const env = { PATH: `C:\\nope;${dir}`, PATHEXT: ".EXE;.CMD" };
      expect(commandOnPath("tool", { env, platform: "win32" })).toBe(true); // ';' split → second dir hits
    });
    expect(commandOnPath("anything", { env: {}, platform: "linux" })).toBe(false);
  });
});
