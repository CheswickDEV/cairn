# CHANGELOG — for the running CLI agent

> **To the agent:** First **finish your current ticket**. Then work the deltas below in
> the order given. **Do NOT rebuild from scratch** and do not re-read the whole repo —
> only the files/locations named here are affected. Most of it is additive; exactly **one**
> change affects already-written code (marked `[CODE-IMPACTING]` below).

---

## Unreleased — Internationalization (English-primary, German selectable) [CODE-IMPACTING]

Makes English the canonical/default language while keeping German a full, selectable runtime locale.

- The whole tool is now **English by default**; German is a full, selectable runtime locale.
- New `src/i18n/` message catalog (`messages.ts` with `en`+`de`, type-enforced locale parity) +
  `lang.ts` (`resolveLang`: `CAIRN_LANG` env > persisted `~/.cairn/config.json` > `en`; `persistLang`).
- Language is chosen at install: `cairn install --lang de|en` flag, or an interactive
  "Language / Sprache? [en]/de" prompt when a TTY is present; persisted; `CAIRN_LANG` overrides per session.
- All runtime user-facing strings are localized via the catalog: CLI help, installer output,
  PowerShell/POSIX shell shortcuts, statusline + zone hints, the
  `context_status`/`handoff`/`decision_log`/`host_status` tool output, host-detect recommendations,
  session-start / pre-compact injections, and the 7-bucket / brief-only prompts.
- **`[CODE-IMPACTING]`** Handoff-brief heads are now stored under a STABLE language-independent key
  `HANDOFF_DECISION_KEY` ("cairn:handoff-brief") instead of the localized title; supersession/re-injection
  also match the legacy German title `LEGACY_HANDOFF_TITLE_DE` so pre-i18n ledgers keep working.
- Repo docs translated to English; the German baseline is archived at git tag `v1.4.0-de` /
  branch `archive/german-v1.4.0`. Calibration fixtures (`docs/calibration/probe-context.md`,
  `ground-truth.json`) intentionally remain German (test data).

---

## 🏷️ 1.4.0 — Continuity UX: lean ledger, named skills, complete help (2026-06-24)

Makes the handoff "usable, not just readable": the ledger stays small, three named trigger skills
("Cairn resume"/"Cairn Handoff"/"Cairn Help") provide a clear entry point, and the instructions say
explicitly "re-injected ledger = source of truth, don't re-read the repo". `[CODE-IMPACTING]` on
`handoff`/`decision_log`/`addCodexAgents` (marked below), the rest additive.

- **`[CODE-IMPACTING]` Lean ledger:** `src/tools/handoff.ts` — a new handoff **supersedes**
  the previous brief heads (`HANDOFF_DECISION_TITLE`, new in `src/core/prompts.ts`), so that
  `decision_log view=current` carries only the latest brief instead of all historical ones. `src/tools/decision_log.ts`
  — `withEvidence` now only applies in `view=all`; `view=current` (Resume) stays lean. Fixes the
  unboundedly growing re-injection (measured: 6 brief heads → 1).
- **Three skills** (`skills/{cairn-handoff,cairn-resume,cairn-help}/SKILL.md`) + project-local mirrors
  under `.claude/skills/` and `.agents/skills/`: trigger words **"Cairn resume"** (re-inject ledger,
  don't re-read), **"Cairn Handoff"** (author + persist a 7-bucket brief), **"Cairn Help"**
  (overview table of triggers/MCP tools/shell).
- **Installer (`src/install/installer.ts`):** the `SKILL_NAMES` list + `copySkills()` deploy all four
  skills to both hosts; `uninstall` removes them. `[CODE-IMPACTING]` `addCodexAgents` now **replaces**
  the `~/.codex/AGENTS.md` block on re-install (previously early-return → stale). The CLI `help` now lists
  installer + shell commands + trigger words + MCP tools.
- **Standing instructions sharpened:** `integration/codex/AGENTS.cairn.md`, `skills/cairn/SKILL.md`
  (+ mirrors), `src/surface/session-start.ts`, `src/server.ts` — "ledger = source of truth, don't re-read
  the whole repo". Resume exception to the "read the ADR in full" rule in `AGENTS.md`/`CLAUDE.md`.
- **Codex window note corrected:** the observed surface cap is `258400` (plan-/client-dependent),
  not a fixed `400k` — `src/core/model-profiles.ts`, `docs/reference/model-profiles.ts`,
  `src/calibration/window-fit.ts`; `BRIDGE_WINDOWS` deliberately stays separate (its own measurement path).
- **Windows test stability:** `host-detect.test.ts` (`path.join`), injectable `psProfilePaths`,
  LF canonicalization of the calibration fixtures (`src/calibration/fixtures.ts`).
- **Tests:** 195 green; strict typecheck + build clean.

---

## 🏷️ 1.3.0 — Shell shortcuts `cairn window`/`tab` via installer (2026-06-23)

`cairn install` now sets up a cross-platform `cairn` shell command that conveniently starts the ambient
Codex zone. `[ADDITIVE]` — no existing code changed. (ADR-0009, ticket T7)

- **New `src/install/shell-shortcuts.ts`** (pure): `mergeMarked`/`unmergeMarked` (idempotent
  marker block `# >>> cairn >>>`), `psShortcut` (PowerShell), `shShortcut` (POSIX), `shSourceInner`.
- **`src/install/installer.ts`:** `install()`/`uninstall()` wire up the command. Windows →
  PowerShell profile (`$PROFILE.CurrentUserAllHosts`, pwsh + 5.1, OneDrive-safe via CLI);
  macOS/Linux → `~/.config/cairn/cairn.sh` + source line in `~/.zshrc`/`~/.bashrc`. Symmetric
  `uninstall`.
- **Commands:** `cairn window` (wt split / tmux / iTerm2 / Terminal.app), `cairn tab` (OSC title),
  `cairn status`/`list`; unknown subcommands → `node server.js` (no conflict with the `cairn` bin).
- 16 new tests (`shell-shortcuts.test.ts`).
- **Open/`provisional`:** macOS interaction (`window` cascade) until the Mac smoke test.

---

## 🏷️ 1.2.1 — Model-ID matching more tolerant (fix) (2026-06-23)

Fix: statusline/`context_status` silently fell back to `generic:unknown` on **decorated model IDs**
(wrong window 128k + green ≤ 50%). Concretely, Opus 4.8 with Claude Code's ID
`claude-opus-4-8[1m]` at ~59k tokens incorrectly showed `🟢 46% ctx` instead of `🟢 6%`. `[CODE-IMPACTING]` —
affects the profile lookup. (ADR-0003)

- **New in `src/core/model-profiles.ts`:** `resolveProfile(id)` + `normalizeModelId(id)` — tolerant
  lookup: exact → normalized-exact → longest separator-bounded profile prefix → `generic:unknown`.
  Covers the `[1m]` suffix (Claude Code 1M), Codex slugs (`gpt-5.5-codex`, dated suffixes) and
  Bedrock/Vertex prefixes (`us.anthropic.…`, `openai/…`).
- **Date suffix in reverse:** matches a profile that has a date in the ID which the host omits
  (`claude-haiku-4-5` → `claude-haiku-4-5-20251001`) — only date-like endings, so that
  `-pro`/`-codex` never collapse incorrectly.
- **Deprecated alias:** `PROFILE_ALIASES` maps outdated IDs to their migration target
  (`gpt-5.3`/`gpt-5.3-codex` → `gpt-5.4`), so old sessions don't end up in the 128k generic.
- **`src/surface/statusline.ts` + `src/tools/context_status.ts`** now use `resolveProfile` instead of
  an exact `find(p => p.id === …)`. The Codex ambient path (`codex-rollout` → `renderStatusline`)
  benefits automatically.
- Verified via a resolution matrix across all profiles + real host variants (Anthropic `[1m]`,
  Codex `-codex`/dated, Bedrock prefix, Haiku without date, deprecated gpt-5.3). 10 new tests
  (`resolveProfile` cases + `[1m]` regression in `surface.test.ts`).

---

## 🏷️ 1.2.0 — Codex ambient zone (rollout reader + title/tmux) (2026-06-23)

Ambient zone display (🟢/🟡/🔴) now **in Codex too**, **without a new dependency** and without a
model call/egress. `[ADDITIVE]` — no existing code changed. (ADR-0008, ticket T6)

- **Read-only rollout reader:** new `src/surface/codex-rollout.ts`. Codex writes a
  `token_count` event per turn with `info.last_token_usage.input_tokens` (usage) + `info.model_context_window`
  (active window) to `~/.codex/sessions/<date>/rollout-*.jsonl`. `parseRolloutUsage()` (pure)
  takes the **last** `token_count` + the last `turn_context.model`, falls back to
  `task_started.model_context_window` and tolerates malformed lines (try/catch per line,
  field presence instead of fragile `type` strings). `renderCodexStatusLine()` maps that onto the
  existing `renderStatusline()` → zone **surface-relative** against the rollout window (ADR-0003),
  not against the model max.
- **Active-session choice:** `findActiveRollout()` takes the newest `*.jsonl` by mtime, and with
  multiple parallel sessions prefers the one with a matching `session_meta.cwd`. Base `~/.codex/sessions`,
  env override `CAIRN_CODEX_SESSIONS` / `CODEX_HOME` (cross-platform via `homedir()`/`path.join`).
- **Two new bins:** `cairn-codex-status` (one-shot → one line on stdout, for tmux/zellij
  `status-interval`; plus `--list`) and `cairn-codex-watch` (pure Node loop,
  `--interval` default **2s**/`--print`; writes the zone into the terminal title via OSC escape —
  portable incl. Windows). No shell, no `which`, no bash env prefix (v1.1.3/1.1.4 lessons).
  Fallback with no active session: "— no active Codex context". Both bins catch `EPIPE` (e.g.
  `--list | head`).
- **Multi-session choice deterministically resolvable:** the default stays "most recently active" (newest mtime, cwd match
  preferred), but with multiple parallel Codex sessions `--session <match>` (or env
  `CAIRN_CODEX_SESSION`) pins a session by UUID/path substring — deterministic (no match → fallback,
  never a foreign session). `cairn-codex-status --list` shows all sessions (zone · UUID · cwd) for
  discovery. UUID = `session_meta.id` (= filename suffix).
- **Integration:** `integration/codex/ambient-zone.md` with tmux/zellij/portable title snippet +
  env overrides and limitations. Bin entries in `package.json` (`dist/bin/...js`).
- **`usedTokens` validated (ADR-0008 follow-up):** against real `~/.codex/sessions` rollouts
  (gpt-5.5 @ 258400, >13k `token_count` events) the window usage is determined as
  `last_token_usage.total_tokens` (= input + output), **not** `input_tokens` alone — the produced
  output rolls into the next request (evidence: `input_tokens(N+1) ≈ total_tokens(N)`), several
  thousand tokens on reasoning-heavy turns. `cached_input_tokens` is a subset and is not
  added. Fallback `input_tokens(+output_tokens)` when `total_tokens` is missing.
- **Note:** the rollout format is Codex-internal/unversioned → parsed defensively, tracked as
  `provisional`; if a Codex release breaks the format, only the display fails, not the
  MCP core.
- 17 new tests (`codex-rollout`), 166 total green.

---

## 🏷️ 1.1.4 — fully platform-neutral (Linux / macOS / Windows) (2026-06-23)

Remaining cross-platform edges closed, **without a new dependency**.

- **npm scripts platform-neutral:** `test`/`dev` used `NODE_OPTIONS=… <cmd>` (bash prefix, fails
  under Windows cmd/PowerShell). Instead the `node:sqlite` ExperimentalWarning is suppressed **in-code**:
  new `src/core/suppress-experimental-warning.ts` (filter on `process.emitWarning`),
  imported in `sqlite-store.ts`. `node:sqlite` is now loaded there via `createRequire` instead of a
  static `import` — otherwise ESM loads the builtin in the link phase, *before* the filter takes effect. The scripts
  are now `vitest run` / `tsx …`. Bonus: the MCP server no longer emits the warning on stderr.
- **CLI detection platform-neutral:** new `src/core/platform.ts` `commandOnPath()` (PATH scan,
  Windows-PATHEXT-aware, no `which` subprocess). Used in installer `hasCli` and `host_status`.
  `host-detect` now builds login evidence paths via `path.join`.
- **Installer fallback** now prints the manual `claude mcp add` command copy-paste-ready
  (path + DB in quotes, against spaces such as "Claude Meta").
- **Bridge** (opt-in) stays unchanged; the README "Known limits" notes that the
  bridge mode runs best on native Windows from Git Bash/WSL (the default account mode is
  fully platform-neutral).
- 5 new tests (`platform`, `suppress-experimental-warning`), 149 total green.

---

## 🏷️ 1.1.3 — Windows cross-platform fixes (2026-06-23)

Two Windows bugs from a real installation (Git Bash + cmd.exe).

- **Codex `config.toml` was invalid TOML.** `codexBlock()` wrote the Windows path as a
  double-quoted *basic string* (`args = ["C:\Users\…"]`) — `\U`, `\T` … are illegal TOML escapes
  and would have made the **entire** config.toml unparseable (all Codex MCP servers dead). Fix: path with
  forward slashes (valid TOML, accepted by Node on Windows).
- **Claude hooks used bash-only syntax.** `NODE_OPTIONS=… node …` is a bash env prefix; Claude
  Code runs hooks on Windows via cmd.exe/PowerShell → "NODE_OPTIONS not recognized", exit 255
  (SessionStart/PreCompact didn't fire). Fix: `node --disable-warning=… script` (runs under cmd,
  PowerShell **and** bash) — in `installer.ts`, `hooks/hooks.json` (plugin) and `settings.example.json`.
- 2 new regression tests (17 in the installer, 144 total).

---

## 🏷️ 1.1.2 — uninstall fully symmetric (2026-06-22)

Fix for an asymmetric uninstall (found while undoing it on Windows).

- **Bug:** `install` appended the Codex snippet to `~/.codex/AGENTS.md` (and created the file if needed),
  but `uninstall` never removed it → a residual remained, had to be cleaned up by hand.
- **Fix:** the snippet is now wrapped in **fence markers** (`<!-- cairn:begin/end -->`). `uninstall`
  cuts the block out exactly; if the file was 100% our snippet (created from empty), it is
  deleted — foreign content is preserved. A **legacy fallback** also removes an AGENTS.md created pre-1.1.2 without markers. 4 new tests (15 in the installer, 142 total).

---

## 🏷️ 1.1.1 — install conflict hardening (2026-06-22)

Fix for a silently shadowing MCP scope conflict (found on Windows while copying the folder).

- **Cause:** a project-scoped `.mcp.json` with an absolute path takes precedence over the user scope.
  If the repo folder is copied to another machine, the path points nowhere and silently shadows
  the correct user-scope registration of the self-installer.
- **The installer now warns:** `conflictingProjectMcp()` detects a `./.mcp.json` that registers cairn to a
  different `server.js`, and prints a clear warning + solution (3 new tests, 11 total).
- Removed the `.mcp.json` (with a Linux path) that had accidentally remained locally; README path C now warns
  against project-scoped absolute paths and points to the self-installer for cross-machine use.

---

## 🏷️ 1.1.0 — one-command installation (2026-06-22)

Installation drastically simplified — no path editing, no 3-step merge anymore.

- **Self-installer `cairn install` / `cairn uninstall`** (`src/install/installer.ts`, dispatch in
  `src/server.ts`): detects Claude Code and/or Codex and wires everything up automatically + idempotently —
  Claude: `~/.claude/settings.json` (statusline + SessionStart/PreCompact hooks) + skill + `claude mcp
  add` (or printed instructions if the CLI is missing); Codex: `~/.codex/config.toml` block + AGENTS snippet
  + skill. The pure merge/TOML helpers are unit-tested (8 tests).
- **Claude Code plugin** (`.claude-plugin/plugin.json` + `marketplace.json`, `hooks/hooks.json`,
  `skills/cairn/SKILL.md`): `/plugin marketplace add <path>` + `/plugin install cairn@cairn` bundles
  MCP server + skill + hooks; `${CLAUDE_PLUGIN_ROOT}` → no path editing.
- **`npm i -g git+<url>`** possible: the `prepare` hook builds `dist/` automatically (replaces `prepack`).
- README/integration docs switched to "simplest way first". 135 tests green.

---

## 🏷️ 1.0.0 — release cut (2026-06-22)

First official cut. Architecture **T0–T7 fully implemented**, strict typecheck clean,
**127 tests green**. Highlights:

- **MCP core + 4 tools** (`host_status`, `context_status`, `handoff`, `decision_log`), account mode
  as the default (no model call/egress), optional bridge/sampling/API behind the egress guardrail.
- **SQLite ledger** (append-only, supersession), `freezeVerbatim` (byte-exact verbatim guarantee),
  zones relative to the surface window, Claude Code statusline + hooks.
- **Calibration** on a robust **5-probe gold set** (ADR-0005); profile effort `gpt-5.4 @xhigh→@high`
  (dominant gold-set pick, ADR-0002 equivalence band). Floor 0.85.
- **Release-ready:** version 1.0.0 (`package.json` + `src/server.ts`), `LICENSE`,
  `README.md` as a complete installation/usage guide,
  packaging metadata (`files` incl. `integration/`, `prepack` build).

The entries below this mark are the **historical agent delta log** of the implementation and
are kept as a reference.

---

## State reconciliation

This changeset describes everything that has been added since the package state (~22:05, which you are
currently working on). Check each entry to see whether you already have it; if so, skip it.

---

## 1. `[CODE-IMPACTING]` Account mode instead of API keys (ADR-0006) — affects **T1**

**What changes:** End users work via their **Claude/Codex accounts**, not via API keys.
The MCP server must make **no** model call in the default.

**Concretely catch up in T1 (only if you have already built `handoff`):**
- **Convert `handoff`**: in the default it takes a 7-bucket brief **produced in-session by the host agent**,
  runs `freezeVerbatim` + validation and persists — **no** server-side model call.
  Optional modes (MCP sampling / bridge / API Bedrock) only if explicitly configured.
- Add a **new 4th tool `host_status`**: detects installed/reachable CLIs (`claude`/`codex`),
  best-effort login status + active session model, prints the login overview.
- `selectSummarizer`: "reachability" = what the **active account session** can invoke (not API key).
  Per-token price is informative in account mode; the logic in the seed stays, only the interpretation/comments change.
- Egress guard: in the default mode **no** egress happens (add a test).

**Sources:** `docs/adr/ADR-cairn.md` (ADR-0006), `docs/backlog.md` (T1, updated), `AGENTS.md` (guardrail 6).
**Not affected:** T0, T2. The domain seed `model-profiles.ts` stays — only the header comment is added.

---

## 2. `[ADDITIVE]` Calibration fixtures are ready (ADR-0005) — affects **T3**

**What's added:** `docs/calibration/probe-context.md` (fixed test base) and
`docs/calibration/ground-truth.json` (28 must_survive / 9 must_not_appear) are **already created**.

**Concretely:** For T3 do **not** generate a probe context yourself — use these fixtures.
Scoring procedure: `docs/calibration-spec.md`, workflow: `docs/calibration/README.md`.
**Not affected:** everything before T3. No back-work.

---

## 3. `[ADDITIVE]` Trigger and continuation flow (ADR-0007) — new tickets **T4, T5**

**What's added:** the zone trigger is "warn, not auto", and by default the result is to
**continue in-place** (the brief becomes the compaction summary, same session), with "fresh"
(SessionStart re-injection) and "cross-model" (bridge) as options. The subagent is the worker.

**Concretely:** Two new, **purely additive** tickets — previously marked "out of scope/later", now
specified:
- **T4** — Claude Code statusline + `PreCompact`/`SessionStart` hooks.
- **T5** — compaction subagent + continuation modes.

**Sources:** `docs/adr/ADR-cairn.md` (ADR-0007), `docs/backlog.md` (T4/T5).
**Not affected:** T0–T3 are not invalidated. The order is now T0→T1→T2→T3→T4→T5; T4/T5 after T1/T2.

---

## Summary "what do I need to touch?"

| Already built? | Action |
|---|---|
| T0 done | nothing — stays valid |
| T1 done/in progress | **convert handoff + add `host_status`** (point 1) |
| T2 done/in progress | nothing — stays valid |
| T3 still open | use the ready fixtures (point 2) |
| T4/T5 | new, additive (point 3) |

If you are currently in the middle of a ticket: finish it, **then** point 1 (if T1 is affected),
then continue normally in backlog order. No rebuild.
