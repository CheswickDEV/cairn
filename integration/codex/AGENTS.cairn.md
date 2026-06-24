# Cairn — on-demand context continuity (append to your AGENTS.md)

> Append this block to `~/.codex/AGENTS.md` (global) or `.agents/AGENTS.md` (project) so Codex
> uses Cairn proactively. Codex has no statusline/hooks, so the agent must call the tools itself.

## Context continuity (Cairn MCP)

- At the **start** of a task, call `decision_log` (`view:"current"`) to re-inject prior accepted +
  open decisions and the latest handoff brief. **This re-injected state is the SOURCE OF TRUTH on
  resume** — do NOT re-read ADR/CHANGELOG or the whole repo; open only the files named in NEXT STEPS
  (or the files you are about to change).
- When the conversation grows long, call `context_status` (pass the model id, used tokens, and
  `surfaceCap` = the host-reported `model_context_window`, e.g. 258400). If it reports **yellow/red**,
  hand off.
- Before finishing or clearing the session — or on yellow/red — produce a **7-bucket brief**
  (DECISIONS incl. superseded, EVIDENCE w/ source refs, OPEN QUESTIONS, CONSTRAINTS, VERBATIM
  byte-exact, NEXT STEPS, DISCARDED) and call `handoff` to persist it. Pass `requiredVerbatim`
  for must-survive values (IDs, scopes, exact numbers). A new handoff supersedes the previous brief,
  so the ledger stays lean.
- Default account mode keeps everything local (no model call by Cairn). Optional `bridge` mode
  (`CAIRN_BRIDGE=claude`) can offload compaction to a logged-in Claude CLI.

## Trigger phrases (skills under `~/.agents/skills/`)

- **"Cairn resume"** → skill `cairn-resume`: call `decision_log` (`view:"current"`), treat it as the
  source of truth, continue from NEXT STEPS, and do NOT re-read the repo.
- **"Cairn Handoff"** → skill `cairn-handoff`: author a 7-bucket brief from the conversation and call
  `handoff` to persist it.
- **"Cairn Help"** → skill `cairn-help`: show the reference table of trigger phrases, MCP tools, and
  shell commands.
