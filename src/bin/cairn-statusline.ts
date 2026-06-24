#!/usr/bin/env node
/** Cairn statusline bin: stdin (Claude Code statusline JSON) → one-line zone status on stdout. */
import { readFileSync } from "node:fs";
import { renderStatusline, type StatuslineInput } from "../surface/statusline.js";
import { resolveLang } from "../i18n/index.js";

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

let input: StatuslineInput = {};
try {
  const raw = readStdin();
  if (raw.trim()) input = JSON.parse(raw) as StatuslineInput;
} catch {
  input = {};
}

process.stdout.write(renderStatusline(input, resolveLang()) + "\n");
