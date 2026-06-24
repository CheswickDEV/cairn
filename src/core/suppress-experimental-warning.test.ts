import { describe, it, expect } from "vitest";
import { shouldSuppressSqliteWarning } from "./suppress-experimental-warning.js";

describe("shouldSuppressSqliteWarning", () => {
  it("suppresses ONLY the node:sqlite experimental warning", () => {
    expect(shouldSuppressSqliteWarning("SQLite is an experimental feature", "ExperimentalWarning")).toBe(true);
    expect(shouldSuppressSqliteWarning(new Error("SQLite is experimental"), "ExperimentalWarning")).toBe(true);
    // options-object form of the type
    expect(shouldSuppressSqliteWarning("SQLite ...", { type: "ExperimentalWarning" })).toBe(true);
  });

  it("passes everything else through", () => {
    expect(shouldSuppressSqliteWarning("Some other experimental feature", "ExperimentalWarning")).toBe(false); // not sqlite
    expect(shouldSuppressSqliteWarning("SQLite ...", "DeprecationWarning")).toBe(false); // wrong type
    expect(shouldSuppressSqliteWarning("a deprecation", "DeprecationWarning")).toBe(false);
    expect(shouldSuppressSqliteWarning("plain warning")).toBe(false); // no type
  });
});
