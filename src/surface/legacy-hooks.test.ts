import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SqliteStore } from "../store/sqlite-store.js";

describe("legacy automatic hook executables are inert", () => {
  for (const bin of ["session-start", "precompact"]) {
    for (const populated of [false, true]) {
      it(`${bin}: no output or ledger writes (${populated ? "existing" : "missing"} ledger)`, () => {
        const dir = mkdtempSync(join(tmpdir(), "cairn-hooks-"));
        const db = join(dir, "ledger.sqlite");
        try {
          if (populated) {
            const store = new SqliteStore({ path: db });
            store.appendDecision({ who: "user", decision: "Keep this decision private", rationale: "test" });
            store.close();
          }
          const before = populated ? readFileSync(db) : undefined;
          const result = spawnSync(process.execPath, [
            "--import", "tsx", fileURLToPath(new URL(`../bin/cairn-${bin}.ts`, import.meta.url)),
          ], {
            input: JSON.stringify({ trigger: "auto", session_id: "test", transcript_path: join(dir, "missing.jsonl") }),
            env: { ...process.env, CAIRN_DB: db }, encoding: "utf8", timeout: 10_000,
          });
          expect(result.status).toBe(0);
          expect(result.stdout).toBe("");
          expect(result.stderr).toBe("");
          expect(readdirSync(dir)).toEqual(populated ? ["ledger.sqlite"] : []);
          if (populated) expect(readFileSync(db)).toEqual(before);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
});
