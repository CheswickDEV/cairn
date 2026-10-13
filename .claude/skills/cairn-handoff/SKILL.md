---
name: cairn-handoff
description: Save a 7-bucket brief through Cairn only when the user explicitly requests Cairn Handoff or invokes this skill. Never activate at task completion, context thresholds, compaction, or a model switch.
disable-model-invocation: true
---

# Cairn Handoff

Run only on an explicit request to save a Cairn handoff, such as **Cairn Handoff**,
`/cairn-handoff`, or `$cairn-handoff`. Quoted mentions and questions about the command do not count.
This invocation does not enable automatic saves or resumes on later turns.

1. Write a concise, faithful brief from the current conversation: **DECISIONS** (including
   superseded decisions), **EVIDENCE** (source references), **OPEN QUESTIONS**, **CONSTRAINTS**,
   **VERBATIM** (required exact values), **NEXT STEPS**, **DISCARDED**. Avoid repeating transcripts.
   State nothing as given that the conversation does not state:
   - Put double quotes only around exact words from the conversation, in one piece without
     omissions; give a decision or constraint the user or another person set in their own words,
     in double quotes.
   - A measured value is evidence, not a target. A deferred option is an open question, not
     discarded.
   - An inference of your own (a constraint, target, reason or step nobody stated) may appear only
     as an item of its own, marked by appending (derived). An empty bucket says none.
2. Call `handoff` in default `account` mode with `brief` and the necessary `requiredVerbatim`.
   Pass your own model id as `host.modelId` when you know it, and the zone when known. Include
   structured `decisions`/`evidence` when available; do not call status tools merely to fill
   optional fields.
3. Check `missingRequired`; if necessary, correct the same brief and retry. Report whether it
   was saved and any unresolved omissions briefly. If the result recommends another summarizer
   model, pass that one line on to the user; do not switch models or retry on your own.

Account mode persists locally without a model call or egress. Each new handoff supersedes the
previous brief. A later resume or another handoff requires a new explicit user request.
