# Cairn — explicit invocation (2026-09-30)

- User decision: invoke Cairn only on an explicit request for the corresponding action.
  No task/session, threshold, compaction or model-switch automation. Resume does not permit
  a later handoff; help does not call tools. Status displays remain informational.
- Updated AGENTS template, all shipped skills, MCP instructions/descriptions, installer,
  plugin/manual templates and documentation (ADR-0010 supersedes earlier automatic hooks).
- Codex skills ship `allow_implicit_invocation: false`; Claude skills ship
  `disable-model-invocation: true`. Installer copies complete host-specific skill folders.
- Reinstall removes only old Cairn hook commands, including mixed entries with foreign hooks.
  Legacy hook executables remain silent no-ops, with no transcript/ledger reads or writes.
- Explicit handoff accepts omitted host/zone metadata, avoiding prerequisite status calls;
  unknown zone uses the conservative selector input, without claiming measured context usage.
- Validation: all 223 Vitest tests passed, plus TypeScript, build, skill validation and package-content check.
  Regression coverage includes upgrades, foreign-hook preservation, no-op legacy executables
  with missing/existing ledgers, and the explicit invocation metadata in packaged skills.
- Explicit user decision after review: keep everything LOCAL. No commit or push authorized;
  do not publish unless the user requests it later. Current task is complete.
- If publication is requested later, existing users update, build, rerun the installer and restart
  their host; manually copied project guidance also needs replacement. GitHub installations keep
  the old behavior until publication. Do not invoke Cairn merely to record task completion.
