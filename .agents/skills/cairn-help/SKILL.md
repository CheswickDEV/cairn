---
name: cairn-help
description: Explain Cairn commands only when the user asks for Cairn Help, Cairn commands, or explicitly invokes this help skill. Help never saves or resumes context.
---

# Cairn Help

On an explicit help request, explain this short reference without calling MCP tools:

| Request | Action |
|---|---|
| **Cairn Handoff** | Save a 7-bucket brief locally with `handoff`. |
| **Cairn resume** | Restore the latest state with `decision_log view="current"` and continue. |
| **Cairn Help** | Explain these commands. |
| Explicit context/host status request | Inspect `context_status` / `host_status`. |

Claude Code supports `/cairn-handoff`, `/cairn-resume`, `/cairn-help`; Codex supports the
corresponding `$cairn-handoff`, `$cairn-resume`, `$cairn-help` invocations.
Shell commands: `cairn status`, `cairn list`, `cairn window`, `cairn tab`, `cairn stop`.

Cairn runs only on explicit requests. There are no automatic task/session, threshold, or
compaction actions. Each invocation covers only that action; resume does not enable a later
handoff. Passive status displays are informational. Account mode is local with no model call
or egress through Cairn, unless the operator set `CAIRN_ACCOUNT_SUMMARIZER=auto`. Do not add a status check, handoff, or resume to a help response.
