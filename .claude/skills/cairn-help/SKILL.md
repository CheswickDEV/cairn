---
name: Cairn Help
description: Trigger phrase "Cairn Help". Print a short reference table of Cairn's trigger phrases, MCP tools, and shell commands so the user can orient quickly. Use when the user says "Cairn Help", "Cairn commands", or asks what Cairn can do.
---

# Cairn Help — quick reference

When the user says **"Cairn Help"** (or invokes `/cairn-help`, or asks what Cairn can do), show this
overview verbatim:

## Trigger phrases — say these in chat, the agent acts

| Say… | What happens |
|------|--------------|
| **Cairn resume** | Re-inject the ledger (`decision_log view=current`) and continue from it as the source of truth — without re-reading the repo. |
| **Cairn Handoff** | Author a 7-bucket brief from the conversation and persist it via `handoff` (local, no egress). |
| **Cairn Help** | Show this table. |

## MCP tools — the agent calls these directly

| Tool | Purpose |
|------|---------|
| `decision_log` | Read / re-inject the ledger. `view:"current"` = lean resume state; `view:"all"` = full history + evidence. |
| `handoff` | Persist a host-written 7-bucket brief (account mode = no model call, nothing leaves the host). |
| `context_status` | Report the zone (🟢/🟡/🔴) relative to the active window. |
| `host_status` | Which host CLIs are logged in + the active model. |

## Shell command — you, in the terminal

| Command | What it shows |
|---------|---------------|
| `cairn status` | One-line zone of the active Codex session (e.g. `🟢 21% ctx · gpt-5.5`). |
| `cairn window` | Live zone strip as a split pane (Windows Terminal / tmux / iTerm2). |
| `cairn tab` / `cairn stop` | Zone in the terminal title / stop it. |
| `cairn list` | All recent Codex sessions (pin one with `--session <uuid>`). |

Cairn is a local-private continuity engine: it persists decisions + evidence across sessions/models and
warns before the context window degrades. In the default account mode nothing leaves the host.
