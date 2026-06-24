import { describe, it, expect } from "vitest";
import {
  mergeMarked,
  unmergeMarked,
  psShortcut,
  shShortcut,
  shSourceInner,
  SHORTCUT_BEGIN,
  SHORTCUT_END,
  type ShortcutPaths,
} from "./shell-shortcuts.js";

const WIN: ShortcutPaths = {
  watch: "C:\\Users\\Tim\\Documents\\Claude Meta\\cairn\\dist\\bin\\cairn-codex-watch.js",
  status: "C:\\Users\\Tim\\Documents\\Claude Meta\\cairn\\dist\\bin\\cairn-codex-status.js",
  server: "C:\\Users\\Tim\\Documents\\Claude Meta\\cairn\\dist\\server.js",
};
const NIX: ShortcutPaths = {
  watch: "/home/u/cairn/dist/bin/cairn-codex-watch.js",
  status: "/home/u/cairn/dist/bin/cairn-codex-status.js",
  server: "/home/u/cairn/dist/server.js",
};

describe("mergeMarked / unmergeMarked", () => {
  it("inserts a marked block into empty content", () => {
    const out = mergeMarked("", "BODY");
    expect(out).toContain(SHORTCUT_BEGIN);
    expect(out).toContain("BODY");
    expect(out).toContain(SHORTCUT_END);
  });

  it("is idempotent — applying twice yields a single block", () => {
    const once = mergeMarked("# my profile\n", "BODY");
    const twice = mergeMarked(once, "BODY");
    expect(twice).toBe(once);
    expect(twice.match(new RegExp(SHORTCUT_BEGIN, "g"))?.length).toBe(1);
  });

  it("replaces an existing block instead of duplicating", () => {
    const v1 = mergeMarked("keep me\n", "OLD");
    const v2 = mergeMarked(v1, "NEW");
    expect(v2).toContain("NEW");
    expect(v2).not.toContain("OLD");
    expect(v2).toContain("keep me");
    expect(v2.match(new RegExp(SHORTCUT_END, "g"))?.length).toBe(1);
  });

  it("preserves surrounding user content", () => {
    const existing = "alias ll='ls -la'\nexport FOO=1\n";
    const merged = mergeMarked(existing, "BODY");
    expect(merged).toContain("alias ll='ls -la'");
    expect(merged).toContain("export FOO=1");
  });

  it("unmergeMarked removes exactly the block (roundtrip)", () => {
    const base = "line a\nline b\n";
    const merged = mergeMarked(base, "BODY");
    const cleaned = unmergeMarked(merged);
    expect(cleaned).not.toContain(SHORTCUT_BEGIN);
    expect(cleaned).not.toContain("BODY");
    expect(cleaned.trim()).toBe(base.trim());
  });

  it("unmergeMarked is a no-op when no block present", () => {
    expect(unmergeMarked("nothing here\n")).toBe("nothing here\n");
  });
});

describe("psShortcut (Windows PowerShell)", () => {
  const fn = psShortcut(WIN);
  it("defines a cairn function with the UI subcommands", () => {
    expect(fn).toContain("function cairn");
    for (const sub of ["'window'", "'tab'", "'stop'", "'status'", "'list'", "'strip'"]) {
      expect(fn).toContain(sub);
    }
  });
  it("forwards unknown subcommands to the server bin (no clash with the cairn bin)", () => {
    expect(fn).toContain('default  { node "$SERVER" $cmd @rest }');
  });
  it("bakes the absolute paths", () => {
    expect(fn).toContain(WIN.watch);
    expect(fn).toContain(WIN.status);
    expect(fn).toContain(WIN.server);
  });
  it("window splits the current Windows Terminal pane", () => {
    expect(fn).toContain("wt -w 0 split-pane");
  });
});

describe("shShortcut (POSIX macOS/Linux)", () => {
  const fn = shShortcut(NIX);
  it("defines a cairn function with the UI subcommands", () => {
    expect(fn).toContain("cairn() {");
    for (const sub of ["window)", "tab)", "stop)", "status)", "list)", "strip)"]) {
      expect(fn).toContain(sub);
    }
  });
  it("window cascades tmux -> iTerm2 -> Terminal.app -> inline", () => {
    expect(fn).toContain("$TMUX");
    expect(fn).toContain("tmux split-window");
    expect(fn).toContain('"$TERM_PROGRAM" = "iTerm.app"');
    expect(fn).toContain('"$TERM_PROGRAM" = "Apple_Terminal"');
    expect(fn).toContain("do script");
  });
  it("tab uses the OSC-title watcher in the background", () => {
    expect(fn).toContain('node "$WATCH" --interval 2');
    expect(fn).toContain("CAIRN_TITLE_PID");
  });
  it("forwards unknown subcommands to the server bin", () => {
    expect(fn).toContain('*)      node "$SERVER" "$@" ;;');
  });
  it("bakes the absolute paths", () => {
    expect(fn).toContain(NIX.watch);
    expect(fn).toContain(NIX.server);
  });
});

describe("shSourceInner", () => {
  it("sources the cairn.sh file if present", () => {
    const line = shSourceInner("/home/u/.config/cairn/cairn.sh");
    expect(line).toContain('. "/home/u/.config/cairn/cairn.sh"');
    expect(line).toContain("-f");
  });
});
