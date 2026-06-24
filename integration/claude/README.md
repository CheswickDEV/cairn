# Claude Code integration

> **Easiest paths first.** After `npm install` (which builds `dist/` via the prepare hook):
>
> - **Self-installer (recommended):** `node dist/server.js install` — wires the MCP server,
>   statusline, hooks and skill into `~/.claude` automatically, no path editing. Reverse with
>   `node dist/server.js uninstall`.
> - **Plugin:** in Claude Code run `/plugin marketplace add /ABSOLUTE/PATH/TO/cairn` then
>   `/plugin install cairn@cairn` — bundles MCP server + skill + hooks (uses `${CLAUDE_PLUGIN_ROOT}`,
>   so no path editing).
>
> The manual steps below are the fallback if you prefer to wire each piece yourself.

---

## Manual setup

Ready-to-install surface skin for Cairn. **Replace `/ABSOLUTE/PATH/TO/cairn`** with your checkout
path after `npm run build` (which produces `dist/`).

## 1. Register the MCP server

Either copy `mcp.json` to your project root as `.mcp.json`, or run:

```bash
claude mcp add cairn -- node /ABSOLUTE/PATH/TO/cairn/dist/server.js
```

This gives the agent the four tools: `host_status`, `context_status`, `handoff`, `decision_log`.

## 2. Install the surface skin (statusline + hooks)

Merge `settings.example.json` into `.claude/settings.json` (project) or `~/.claude/settings.json`
(user). It wires:

- **statusLine** → `cairn-statusline` shows the live context zone (🟢/🟡/🔴) relative to the
  active window.
- **SessionStart hook** (matcher `startup|resume|compact`) → `cairn-session-start` re-injects the
  ledger (accepted + open decisions + the latest handoff brief) as `additionalContext`. The
  `compact` matcher fires right **after** a host auto-compaction (not summarized), carrying Cairn's
  faithful brief into the continued session — this is the in-place continuation (ADR-0007).
- **PreCompact hook** → `cairn-precompact` detects the imminent compaction and secures a safety-net
  snapshot to the ledger + nudges. (A PreCompact hook cannot replace the host summary; the carry-
  through is the SessionStart `compact` matcher above — see ADR-0007 correction 2026-06-22.)

## 3. The skill

`.claude/skills/cairn/SKILL.md` (in the repo) tells the agent *when* to call the tools (check
`context_status`, `handoff` on yellow/red or before compaction, `decision_log` to re-inject).
Copy it to your project `.claude/skills/` or `~/.claude/skills/`.

## Compaction modes (ADR-0006)

- **Default (account):** the agent writes the brief in-session on your subscription; Cairn makes
  no model call.
- **Bridge:** set `CAIRN_ENABLE_MODES=bridge` + `CAIRN_BRIDGE=claude|codex` to let Cairn compact
  via the other logged-in CLI's subscription (`claude -p` / `codex exec`).
- **Sampling:** set `CAIRN_ENABLE_MODES=sampling` to let Claude Code run the completion on your
  account via MCP sampling (capability-gated).
- **API:** `CAIRN_ENABLE_MODES=api` + `CAIRN_ENDPOINT_*` for headless org runs (needs creds).
