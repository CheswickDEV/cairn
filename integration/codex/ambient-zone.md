# Cairn — ambient zone display for Codex (ADR-0008)

> Codex has no statusline/hooks, but it writes a `token_count` event per turn into its rollout
> file (`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`). Cairn reads that file **read-only,
> out-of-band** and renders the quality zone (🟢/🟡/🔴) — same zone logic as the Claude Code
> statusline, computed against the **active window from the rollout** (ADR-0003). No new
> dependency, no model call, no credentials.

Two bins (after `npm run build`):

- `cairn-codex-status` — one-shot: prints **one line** (e.g. `🟢 8% ctx · gpt-5.5`) and exits.
  Ideal for tmux/zellij `status-interval` or `watch`. `--list` prints all recent sessions;
  `--session <match>` pins one (see *Multiple sessions* below).
- `cairn-codex-watch` — polling loop. Default: writes the line into the **terminal title** (OSC
  escape) so the zone shows in your window/tab title (portable, incl. Windows Terminal/PowerShell).
  `--print` refreshes a single line in place (for a dedicated pane). `--interval N` (default **2 s**).
  `--session <match>` pins a session.

If no active Codex rollout is found, the line reads `— no active Codex context`.
(These status-line strings appear in German when installed with `--lang de` or run with `CAIRN_LANG=de`.)

## Fastest way: the `cairn` shell command (set up by the installer, ADR-0009)

`cairn install` creates a `cairn` shell function (Windows: PowerShell profile; macOS/Linux:
`~/.config/cairn/cairn.sh`, sourced from `~/.zshrc`/`~/.bashrc`). In a **new** terminal:

- `cairn window` — zone strip as a second pane in the current window (Windows Terminal split /
  tmux / iTerm2 / Terminal.app).
- `cairn tab` — zone in the terminal title; `cairn stop` ends it.
- `cairn status` / `cairn list` — one-shot display / all sessions.

Other subcommands (`install`, `uninstall`, …) are forwarded by the function to the `cairn` CLI.
`uninstall` removes the function again. (macOS `window` is `provisional` until the Mac smoke test.)

## (a) tmux — zone in the status bar

```tmux
# ~/.tmux.conf
set -g status-interval 2
set -g status-right "#(cairn-codex-status)"
```

## (b) zellij — zone via a command pane

zellij has no shell-command status field; run the watcher in a small pane (KDL layout):

```kdl
// layout.kdl
pane size=1 {
    command "cairn-codex-watch"
    args "--print" "--interval" "2"
}
```

## (c) portable / Windows — zone in the window title

Start the watcher once in (a possibly second) terminal that hosts your Codex session; it keeps the
window title in sync with the current zone:

```sh
cairn-codex-watch            # title mode (default), 2 s interval
cairn-codex-watch --interval 5
cairn-codex-watch --print    # in-place line instead of the title (dedicated pane)
```

Run via Node directly if the bins aren't on PATH:

```sh
node /ABSOLUTE/PATH/TO/cairn/dist/bin/cairn-codex-watch.js
```

## Multiple parallel sessions — pin the one you want

By default Cairn shows the **most recently active** session (newest rollout by mtime, preferring one
whose `session_meta.cwd` matches your current directory). That is correct for the common single-session
case. When several Codex sessions run at once, pin one explicitly:

```sh
cairn-codex-status --list          # → "<zone>  ·  <session-UUID>  ·  <cwd>" per session
cairn-codex-status --session 019eef84            # pin by UUID (any unique substring)
cairn-codex-watch  --session 019eef84            # same, for the title watcher
export CAIRN_CODEX_SESSION=019eef84              # or pin via env (handy for tmux)
```

The match is any substring of the rollout path (the session UUID is the most stable choice; it is the
filename suffix and `session_meta.id`). A pin is deterministic: if nothing matches you get
`— no active Codex context`, never a different session. Codex shows its session id via `/status`,
or use `--list`.

## Session directory & overrides

Default base is `~/.codex/sessions`. Override (cross-platform) with either:

- `CAIRN_CODEX_SESSIONS` — the sessions directory directly, or
- `CODEX_HOME` — Cairn reads its `sessions/` subdirectory.

## Limitations (intentional, `provisional`)

- **Format coupling:** the rollout layout is Codex-internal and unversioned (ADR-0008). Parsing is
  defensive; if a Codex release changes the format, only this ambient display degrades — never the
  MCP core. The reader is deliberately **out-of-band** (not DOM-scraping in the product path, which
  ADR-0001 forbids).
- **`usedTokens`** = `last_token_usage.total_tokens` (input + output), validated against real rollouts
  (ADR-0008 follow-up). It is a per-turn snapshot: it updates once Codex writes the turn's
  `token_count` event (no live update mid-turn).
- **Active-session pick** is heuristic (newest by mtime, `session_meta.cwd` match preferred); for the
  multi-session case pin explicitly with `--session` / `CAIRN_CODEX_SESSION` (see above).
