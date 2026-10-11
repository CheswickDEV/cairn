---
name: cairn-handoff
description: Save a 7-bucket brief through Cairn only when the user explicitly requests Cairn Handoff or invokes this skill. Never activate at task completion, context thresholds, compaction, or a model switch.
---

# Cairn Handoff

Run only on an explicit request to save a Cairn handoff, such as **Cairn Handoff**,
`/cairn-handoff`, or `$cairn-handoff`. Quoted mentions and questions about the command do not count.
This invocation does not enable automatic saves or resumes on later turns.

1. Write a concise, faithful brief from the current conversation: **DECISIONS** (including
   superseded decisions), **EVIDENCE** (source references), **OPEN QUESTIONS**, **CONSTRAINTS**,
   **VERBATIM** (required exact values), **NEXT STEPS**, **DISCARDED**. Avoid repeating transcripts.
2. Call `handoff` in default `account` mode with `brief` and the necessary `requiredVerbatim`.
   Include structured `decisions`/`evidence` and known host/zone values when available; do not
   call status tools merely to fill optional fields.
3. Check `missingRequired`; if necessary, correct the same brief and retry. Report whether it
   was saved and any unresolved omissions briefly.

Account mode persists locally without a model call or egress. Each new handoff supersedes the
previous brief. A later resume or another handoff requires a new explicit user request.
