---
name: cairn
description: Use Cairn only on an explicit user request to save or resume context, explain its commands, or inspect its status. Never activate because a session starts, ends, grows long, or compacts.
disable-model-invocation: true
---

# Cairn — explicit requests only

Use only the action the user requested. A mention in documentation, a quotation, or a question
about Cairn is not a request to save, resume, or inspect context. One invocation does not enable
automation for later turns. Do not call tools at startup, task completion, context thresholds,
compaction, clearing, or a model/host switch. Do not add recurring reminders.

- **Cairn Handoff**: follow `cairn-handoff` to write and persist a 7-bucket brief with `handoff`.
- **Cairn resume**: follow `cairn-resume`; `decision_log view="current"` restores prior state.
- **Cairn Help**: follow `cairn-help`; explain commands without tool calls.
- An explicit context-status request permits `context_status`: pass the known model, token
  usage and surface cap. A yellow/red result is information, not permission to save a handoff.
- An explicit host-status request permits `host_status` to inspect available host CLIs.

Default account mode stores locally with no model call or egress (unless the operator opted in to
automatic compaction with `CAIRN_ACCOUNT_SUMMARIZER=auto`). Optional bridge, sampling, and API modes
need explicit configuration. No extra status calls are needed for handoff/resume.
