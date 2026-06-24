---
name: Cairn Context Continuity
description: Use Cairn's MCP tools to track context-window zones, hand off a 7-bucket brief before context degrades, and re-inject prior decisions. Invoke when the session is getting long, before compaction, or when resuming work.
---

# Cairn — AI Context Continuity Engine

Cairn is a local MCP server that keeps decisions + evidence across sessions/models and warns
before you run into the degraded part of the context window. Use its four tools:

## When to call which tool

- **`context_status`** — check where you are. Pass the active model id, used tokens, and (if the
  surface caps the window) `surfaceCap`. It returns the zone (green/yellow/red) relative to the
  *active* window. Check it when the session feels long. The Claude Code statusline shows this
  ambiently; call the tool when you want the exact boundaries.

- **`handoff`** — **the core action.** When `context_status` is **yellow or red**, or right before
  a compaction, produce a **7-bucket brief** and call `handoff` with it (account mode — you, the
  host agent, write the brief on the user's own subscription; Cairn just freezes verbatim spans
  and persists). The 7 buckets: DECISIONS (mark superseded ones), EVIDENCE (with source refs),
  OPEN QUESTIONS, CONSTRAINTS, VERBATIM (code/IDs/values byte-exact), NEXT STEPS, DISCARDED.
  Pass `requiredVerbatim` for any value that MUST survive byte-exact, and structured
  `decisions`/`evidence` when you can extract them. **Prefer producing the brief in a subagent
  (Task tool)** so the compaction reasoning tokens don't bloat the main context (ADR-0007).
- **Continuation (ADR-0007):** the brief is persisted to the ledger and the same session continues
  in place — after a host auto-compaction the `SessionStart`(`compact`) hook re-injects the brief
  faithfully (not summarized). For a fresh start or the other host, the ledger re-injects via
  `decision_log` / SessionStart.

- **`decision_log`** — at session start or when you need the prior state, call with
  `view:"current"` to reconstruct accepted + open decisions (superseded ones are kept but
  excluded). **On resume this re-injected state is the source of truth — don't re-read the whole
  repo; open only the files named in NEXT STEPS.** Use `view:"all"` for the full history + evidence.

- **`host_status`** — at startup, to see which host CLIs are logged in and which model is active.

## Quick actions (skills)

- Say **"Cairn resume"** (`cairn-resume`) — re-inject the ledger and continue without re-reading the repo.
- Say **"Cairn Handoff"** (`cairn-handoff`) — author + persist a 7-bucket brief now.
- Say **"Cairn Help"** (`cairn-help`) — show the command / trigger reference table.

## Principles (from the ADRs)

- Fidelity over cost: a faithful brief matters more than a cheap one.
- Local-private: in the default mode nothing leaves the host; Cairn makes no model call.
- When in doubt, prefer a longer, complete handoff over a short, lossy one.
