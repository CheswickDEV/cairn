---
name: Cairn Context Continuity
description: Use Cairn's MCP tools (host_status, context_status, handoff, decision_log) to track context-window zones, hand off a 7-bucket brief before context degrades, and re-inject prior decisions. Codex has no ambient statusline/hooks, so call these proactively when a session grows long or before wrapping up.
---

# Cairn — AI Context Continuity Engine (Codex)

Cairn is a local MCP server keeping decisions + evidence across sessions/models. On Codex there
is **no statusline and no hooks** — so YOU must call the tools on-demand:

- **`decision_log` (view:"current")** — at the start of a task, to re-inject accepted + open
  decisions and the latest brief from prior sessions. **This re-injected state is the source of
  truth on resume — do NOT re-read ADR/CHANGELOG or the whole repo; open only the files named in
  NEXT STEPS.**
- **`context_status`** — periodically when the conversation grows long; pass the model id and
  used tokens. It returns the zone (green/yellow/red) relative to the active window. (Codex caps
  the window — pass the host-reported `model_context_window`, e.g. 258400, as `surfaceCap`.)
- **`handoff`** — when yellow/red, or before you finish/clear the session, write a **7-bucket
  brief** (DECISIONS incl. superseded, EVIDENCE w/ source refs, OPEN QUESTIONS, CONSTRAINTS,
  VERBATIM byte-exact, NEXT STEPS, DISCARDED) and call `handoff` (account mode — you write it on
  the user's ChatGPT/Codex subscription; Cairn freezes verbatim + persists). Pass
  `requiredVerbatim` for must-survive values.
- **`host_status`** — to see which CLIs are logged in.

## Trigger phrases (skills under `~/.agents/skills/`)

- **"Cairn resume"** (`cairn-resume`) — re-inject the ledger, continue, don't re-read the repo.
- **"Cairn Handoff"** (`cairn-handoff`) — author + persist a 7-bucket brief.
- **"Cairn Help"** (`cairn-help`) — show the command / trigger reference table.

Codex does **not** support MCP sampling, so server-initiated compaction is unavailable; use the
default account mode (you write the brief) or the bridge mode (`CAIRN_BRIDGE=claude`) to compact
via a logged-in Claude CLI.

Principles: fidelity over cost; local-private (no model call in the default mode); when in doubt,
a complete verbatim handoff beats a short lossy one.
