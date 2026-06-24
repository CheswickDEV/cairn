---
name: Cairn Handoff
description: Trigger phrase "Cairn Handoff". Author a 7-bucket handoff brief from the current conversation and persist it via Cairn's `handoff` MCP tool (default account mode — no model call, nothing leaves the host). Use when the user says "Cairn Handoff", before clearing the session, on a yellow/red context zone, or before switching model/host.
---

# Cairn Handoff — persist this session as a 7-bucket brief

Trigger: the user says **"Cairn Handoff"**, or you are about to clear/finish the session or switch model/host.

Do this:

1. **Write a faithful 7-bucket brief** from THIS conversation — nothing invented, nothing padded:
   - **DECISIONS** (mark superseded ones), **EVIDENCE** (each with a source ref: `file:line`, `msg#`,
     url, or tool output), **OPEN QUESTIONS**, **CONSTRAINTS**, **VERBATIM** (code/IDs/values/paths
     byte-exact), **NEXT STEPS**, **DISCARDED**.
2. **Call the `handoff` MCP tool** (leave `mode` at its default `account` → no model call, no egress;
   on Codex you write the brief on the user's ChatGPT/Codex subscription):
   - `brief`: the full brief text.
   - `requiredVerbatim`: every value that MUST survive byte-exact (IDs, exact numbers, file paths, flags).
   - `decisions` / `evidence`: the structured form when you can extract it.
   - `host`: the current model/provider; `sourceZone`: the current zone (green/yellow/red).
3. **Report back**: `storedDecisionId`, `decisionsStored`, and `missingRequired`. If `missingRequired`
   is non-empty, fix the brief so those spans appear byte-exact and call `handoff` again.

Notes:
- A new handoff **supersedes the previous brief automatically**, so the ledger stays lean — old briefs
  do not pile up in `decision_log view=current`.
- Account mode persists locally only; nothing is sent to any model.
- To pick the work back up later, use **"Cairn resume"** (skill `cairn-resume`).
