---
name: Cairn Resume
description: Trigger phrase "Cairn resume". Re-inject prior state from the Cairn ledger via `decision_log` and continue from it as the SOURCE OF TRUTH — without re-reading the whole repo. Use when the user says "Cairn resume", or at the start of resumed work.
---

# Cairn resume — continue from the ledger, don't re-read the repo

Trigger: the user says **"Cairn resume"**, or you are picking up prior work at the start of a task.

Do this:

1. **Call `decision_log`** (`view:"current"`) to re-inject the accepted + open decisions and the latest
   handoff brief.
2. **Treat that re-injected state as the authoritative source of truth.** Continue from its NEXT STEPS.
3. **Do NOT re-read the repo wholesale** — not `ADR-cairn.md`, not `CHANGELOG.md`, not the source tree.
   Open ONLY the specific files named in NEXT STEPS, or the files you are about to change. Re-reading
   the repo is exactly the context bloat the ledger exists to prevent — the brief is the trusted summary.
4. Optional: call `context_status` to see the current zone (Codex has no statusline/hooks, so check it
   yourself; pass the host-reported `model_context_window`, e.g. 258400, as `surfaceCap`). If you need a
   value byte-exact that the brief references, pull its evidence with `decision_log` `view:"all"`.

When you reach a natural stopping point, or the zone turns yellow/red, run **"Cairn Handoff"** (skill
`cairn-handoff`) to persist progress.
