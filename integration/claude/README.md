# Claude Code integration

After `npm install` builds `dist/`, run `node dist/server.js install` to register the MCP server,
install explicit-only skills and the passive statusline. Re-running install updates existing
skills and removes Cairn's old SessionStart/PreCompact hooks, preserving other hooks.
Restart Claude Code afterward. Uninstall with `node dist/server.js uninstall`.

Alternatively, use `/plugin marketplace add /ABSOLUTE/PATH/TO/cairn` followed by
`/plugin install cairn@cairn`. The plugin ships the MCP server and explicit-only skills,
without automatic hooks. The self-installer additionally configures the statusline.

## Manual setup

1. Register: `claude mcp add cairn -- node /ABSOLUTE/PATH/TO/cairn/dist/server.js`, or use `mcp.json`.
2. Merge `settings.example.json` into your settings after replacing the checkout path.
   It configures only a passive statusline; remove old Cairn SessionStart/PreCompact entries.
3. Copy the complete folders from `skills/` into `~/.claude/skills/` or project `.claude/skills/`.
   They set `disable-model-invocation: true`; invoke `/cairn-handoff`, `/cairn-resume`, `/cairn-help`.

The MCP instructions also recognize explicit requests such as **Cairn Handoff** or **Cairn resume**.
Mentioning Cairn, starting/ending work, switching hosts, zone thresholds or compaction does not
trigger it. Each request covers only its action. Help and passive displays do not call tools.
Old hook executables are silent compatibility no-ops; they do not read transcripts or the ledger.

Default account mode persists a host-written brief locally, without a model call or egress.
Optional bridge, sampling and API modes still need explicit configuration; see the main README.
