/**
 * Cairn - message catalog (i18n). English is the canonical default; German is a full parallel.
 *
 * The `Messages` interface is implemented once per locale, so TypeScript enforces that every key
 * exists in BOTH `en` and `de` (full-locale parity). Interpolated messages are function-valued so
 * their params are type-checked and each locale owns its own template (no ICU; locale-specific
 * plural/pluralish wording lives inside that locale's function). `t(lang)` returns the catalog for
 * a language; callers read `m.section.key` or invoke `m.section.key({ … })`.
 */

import type { Lang } from "./lang.js";

export type Zone3 = "green" | "yellow" | "red";

export interface Messages {
  statusline: {
    /** Trailing zone hint appended to the one-line statusline (green = none). */
    hint: Record<Zone3, string>;
  };
  codex: {
    noContext: string;
    noSessions: string;
  };
  contextStatus: {
    rec: Record<Zone3, string>;
    body: (p: {
      model: string;
      used: string;
      window: string;
      pct: string;
      green: string;
      yellow: string;
      red: string;
    }) => string;
  };
  handoff: {
    selModel: (p: { model?: string; reason: string }) => string;
    selVerbatim: (p: { reason: string }) => string;
    missingVerbatim: (p: { spans: string }) => string;
    result: (p: {
      mode: string;
      egress: boolean;
      selection: string;
      holds: number;
      decisions: number;
      evidence: number;
      id: string;
      warn: string;
    }) => string;
    /** Evidence `claim` recorded for each frozen verbatim hold. */
    verbatimClaim: string;
  };
  decisionLog: {
    header: (p: { count: number; view: string }) => string;
    supersededBy: (p: { id: string }) => string;
    empty: string;
  };
  hostStatus: {
    overviewTitle: string;
    installed: string;
    notFound: string;
    loginUnknown: string;
    loggedIn: string;
    noLogin: string;
    modelSuffix: (p: { model: string }) => string;
    recommendationLabel: string;
    notFoundRec: (p: { cli: string; altModel: string }) => string;
    loggedInRec: (p: { cli: string; model?: string }) => string;
    notLoggedInRec: (p: { cli: string }) => string;
    noReadyHost: string;
    loginNote: string;
  };
  sessionStart: {
    header: (p: { count: number }) => string;
    evidenceNote: (p: { n: number }) => string;
    briefHeader: string;
    sourceOfTruth: string;
    /** Friendly display label for a handoff-brief head (the stored value is the stable key). */
    handoffTitle: string;
  };
  preCompact: {
    decision: (p: { trigger: string }) => string;
    rationale: (p: { session?: string }) => string;
    transcriptTailClaim: string;
    systemMessage: string;
  };
  shell: {
    helpLine: string;
    titleRunningPs: string;
    titleRunningPosix: string;
    titleStopped: string;
    noTitleActive: string;
    noTmux: string;
  };
  install: {
    help: string;
    noHost: string;
    noHostHint: string;
    title: string;
    claudeHeader: string;
    settingsOk: (p: { path: string }) => string;
    skillsClaude: string;
    mcpRegistered: string;
    mcpAddFailed: string;
    mcpManual: string;
    conflictMcp: string;
    conflictScope: string;
    conflictFix: string;
    codexHeader: string;
    codexTomlOk: (p: { path: string }) => string;
    agentsAdded: string;
    skillsCodex: string;
    shellHeader: string;
    skillSourceMissing: (p: { src: string }) => string;
    shellNoPs: string;
    shellPsOk: string;
    shellPsHint: string;
    shellPosixOk: (p: { path: string }) => string;
    shellPosixHint: string;
    langSet: (p: { lang: string }) => string;
    doneInstall: string;
    uninstallTitle: string;
    settingsCleaned: string;
    mcpRemoved: string;
    mcpRemoveManual: string;
    tomlRemoved: string;
    tomlCleaned: string;
    agentsRemoved: string;
    agentsCleaned: string;
    agentsRemovedLegacy: string;
    shellRemoved: string;
    doneUninstall: string;
    langPrompt: string;
  };
  prompts: {
    sevenBucket: string;
    briefOnly: string;
  };
}

const EN: Messages = {
  statusline: {
    hint: { green: "", yellow: " · ⚠ consider handoff", red: " · handoff now" },
  },
  codex: {
    noContext: "— no active Codex context",
    noSessions: "— no Codex sessions found",
  },
  contextStatus: {
    rec: {
      green: "🟢 Green zone — context clean, no handoff needed.",
      yellow: "⚠ Yellow zone — consider `handoff` before recall/accuracy degrade.",
      red: "🔴 Red zone — `handoff` now; the context is in the degraded range.",
    },
    body: (p) =>
      `Model ${p.model}: ${p.used} / ${p.window} tokens (${p.pct}%). ` +
      `Green ≤ ${p.green}, Yellow ≤ ${p.yellow}, Red up to ${p.red}.`,
  },
  handoff: {
    selModel: (p) => `model ${p.model} (${p.reason})`,
    selVerbatim: (p) => `VERBATIM FALLBACK (${p.reason})`,
    missingVerbatim: (p) => `⚠ Not preserved byte-exact: ${p.spans}`,
    result: (p) =>
      `Handoff saved [${p.mode}, egress=${p.egress}]. Selection: ${p.selection}.\n` +
      `${p.holds} verbatim block(s), ${p.decisions} decision(s), ` +
      `${p.evidence} evidence entr${p.evidence === 1 ? "y" : "ies"} → ${p.id}.${p.warn}`,
    verbatimClaim: "verbatim-protected span",
  },
  decisionLog: {
    header: (p) => `${p.count} decision(s) [${p.view}]:`,
    supersededBy: (p) => ` → replaced by ${p.id}`,
    empty: "No decisions in the store.",
  },
  hostStatus: {
    overviewTitle: "Sign-in overview:",
    installed: "installed",
    notFound: "not found",
    loginUnknown: "login: unknown",
    loggedIn: "signed in",
    noLogin: "no login detected",
    modelSuffix: (p) => `, model ${p.model}`,
    recommendationLabel: "Recommendation",
    notFoundRec: (p) => `${p.cli} not found — sign in to ${p.cli} for ${p.altModel} as an alternative.`,
    loggedInRec: (p) => `${p.cli} signed in${p.model ? ` (${p.model})` : ""}.`,
    notLoggedInRec: (p) => `${p.cli} installed, but no login detected (best-effort) — sign in if needed.`,
    noReadyHost: "No signed-in host detected — account mode needs a signed-in host session.",
    loginNote:
      "Login detection is best-effort (config-file presence). Installed CLIs are detected " +
      "reliably; the exact login status is not always.",
  },
  sessionStart: {
    header: (p) => `Cairn — continued context from the decision ledger (${p.count} open/active):`,
    evidenceNote: (p) => ` (${p.n} evidence)`,
    briefHeader: "Latest handoff brief (faithful, not summarized):",
    sourceOfTruth:
      "This state is the source of truth — do NOT re-read the whole repo, open only the files named " +
      'in NEXT STEPS. Full state via decision_log (view=current); save a new brief via "Cairn Handoff".',
    handoffTitle: "Session handoff (7-bucket brief)",
  },
  preCompact: {
    decision: (p) => `Context compaction (${p.trigger})`,
    rationale: (p) => `Compaction event${p.session ? ` · session ${p.session}` : ""}`,
    transcriptTailClaim: "Transcript tail (lossless verbatim fallback before compaction)",
    systemMessage:
      "Cairn: host compaction detected — ledger secured; Cairn's brief is re-injected via " +
      "SessionStart(compact). Tip: capture open decisions with `handoff` first.",
  },
  shell: {
    helpLine: "cairn: window | tab | stop | status | list   (others -> cairn-CLI: install, uninstall, ...)",
    titleRunningPs: "cairn: zone running in tab title (PID $($global:CairnTitle.Id)). Stop: cairn stop",
    titleRunningPosix: "cairn: zone running in terminal title (PID $CAIRN_TITLE_PID). Stop: cairn stop",
    titleStopped: "cairn: title display stopped.",
    noTitleActive: "cairn: no title display active.",
    noTmux: "cairn: no tmux/iTerm2 detected — use 'cairn tab' (title) or start in tmux. Strip inline:",
  },
  install: {
    help: [
      "cairn — AI Context Continuity Engine",
      "",
      "Installer:",
      "  cairn install     — wires Cairn into Claude Code and/or Codex (idempotent)",
      "  cairn uninstall   — removes the Cairn entries again",
      "  (add --lang de|en to install in German or English)",
      "",
      "Shell commands (after install, in the terminal):",
      "  cairn status      — current Codex context zone status (one line)",
      "  cairn window      — live zone strip as a second pane (Windows Terminal / tmux / iTerm2)",
      "  cairn tab         — zone in the terminal/tab title · 'cairn stop' ends it",
      "  cairn list        — recently active Codex sessions (pin with --session <uuid>)",
      "",
      "Trigger words (say in chat — the agent acts):",
      '  "Cairn resume"    — re-inject the ledger (decision_log view=current) and keep working as the',
      "                      source of truth, WITHOUT re-reading the repo",
      '  "Cairn Handoff"   — author a 7-bucket brief from the conversation and persist it via handoff',
      '  "Cairn Help"      — this overview (skill cairn-help)',
      "",
      "MCP tools (the agent calls directly):",
      "  decision_log      — read/re-inject the ledger (view=current lean · view=all full history + evidence)",
      "  handoff           — save a 7-bucket brief (account mode = no model call/egress)",
      "  context_status    — zone 🟢/🟡/🔴 relative to the active window",
      "  host_status       — which host CLIs are signed in + the active model",
    ].join("\n"),
    noHost: "No Claude Code (~/.claude) and no Codex (~/.codex) detected.",
    noHostHint: "Install one of the hosts and sign in, then run `cairn install` again.",
    title: "Cairn install",
    claudeHeader: "• Claude Code:",
    settingsOk: (p) => `  ✓ settings.json — statusline + SessionStart/PreCompact hooks (${p.path})`,
    skillsClaude: "  ✓ Skills → ~/.claude/skills/ (cairn, cairn-handoff, cairn-resume, cairn-help)",
    mcpRegistered: "  ✓ MCP server registered (claude mcp add, scope user)",
    mcpAddFailed: "  ⚠ 'claude mcp add' failed — please run manually:",
    mcpManual: "  ℹ claude CLI not on PATH — register MCP manually:",
    conflictMcp: "  ⚠ Conflict: ./.mcp.json registers cairn project-scoped to a different path:",
    conflictScope: "    Project scope takes precedence over user scope → the wrong server would apply here.",
    conflictFix: "    Fix: delete ./.mcp.json (user scope covers cairn everywhere) or adjust the path.",
    codexHeader: "• Codex:",
    codexTomlOk: (p) => `  ✓ config.toml — [mcp_servers.cairn] (${p.path})`,
    agentsAdded: "  ✓ AGENTS.md updated (~/.codex/AGENTS.md)",
    skillsCodex: "  ✓ Skills → ~/.agents/skills/ (cairn, cairn-handoff, cairn-resume, cairn-help)",
    shellHeader: "• Shell:",
    skillSourceMissing: (p) => `  ⚠ Skill source not found (${p.src}) — skipped.`,
    shellNoPs: "  ℹ no PowerShell found — shell command 'cairn' skipped.",
    shellPsOk: "  ✓ Shell command 'cairn' (window/tab/status/list) → PowerShell profile",
    shellPsHint: "    Open a new PowerShell window, then e.g. 'cairn window'.",
    shellPosixOk: (p) => `  ✓ Shell command 'cairn' (window/tab/status/list) → ${p.path} (+ ~/.zshrc/.bashrc)`,
    shellPosixHint: "    Open a new shell (or re-source rc), then e.g. 'cairn window'.",
    langSet: (p) => `  ✓ Language: ${p.lang} (set CAIRN_LANG to override per session)`,
    doneInstall: "Done. Restart Claude Code / Codex so the MCP server + hooks take effect.",
    uninstallTitle: "Cairn uninstall",
    settingsCleaned: "  ✓ settings.json cleaned (statusline + hooks removed)",
    mcpRemoved: "  ✓ MCP server removed (claude mcp remove)",
    mcpRemoveManual: "  ℹ claude CLI not on PATH — if needed manually: claude mcp remove cairn --scope user",
    tomlRemoved: "  ✓ config.toml removed (was only the Cairn block)",
    tomlCleaned: "  ✓ config.toml cleaned ([mcp_servers.cairn] removed)",
    agentsRemoved: "  ✓ AGENTS.md removed (was entirely the Cairn snippet)",
    agentsCleaned: "  ✓ AGENTS.md cleaned (Cairn snippet removed)",
    agentsRemovedLegacy: "  ✓ AGENTS.md removed (legacy Cairn snippet)",
    shellRemoved: "  ✓ Shell command 'cairn' removed",
    doneUninstall: "Removed. (The ledger under ~/.cairn is kept — delete it manually if needed.)",
    langPrompt: "Language / Sprache? [en]/de: ",
  },
  prompts: {
    sevenBucket: [
      "Condense the following AI chat context into a handoff brief with EXACTLY these 7 buckets:",
      "1) DECISIONS — current decisions; mark superseded ones explicitly as 'superseded'.",
      "2) EVIDENCE — evidence with a source ref (e.g. msg#NN, file, URL).",
      "3) OPEN QUESTIONS — open points / still to clarify.",
      "4) CONSTRAINTS — hard constraints / target metrics.",
      "5) VERBATIM — protected blocks (code/IDs/values/URLs) carried over BYTE-EXACT, not paraphrased.",
      "6) NEXT STEPS — concrete next steps.",
      "7) DISCARDED — discarded dead-ends (briefly).",
      "Rules: No content outside the buckets. Invent nothing. Leave markers of the form [[CAIRN-HOLD-n]]",
      "unchanged (they are restored byte-exact afterwards).",
    ].join("\n"),
    briefOnly: [
      "You are a pure compaction service, NOT an interactive agent.",
      "Output ONLY the brief — no preamble, no meta-commentary, no mention of yourself, tools,",
      "repository, directory, or MCP connection. Do not use tools.",
      "Begin the response directly with '1) DECISIONS'.",
    ].join(" "),
  },
};

const DE: Messages = {
  statusline: {
    hint: { green: "", yellow: " · ⚠ handoff erwägen", red: " · handoff jetzt" },
  },
  codex: {
    noContext: "— kein aktiver Codex-Kontext",
    noSessions: "— keine Codex-Sessions gefunden",
  },
  contextStatus: {
    rec: {
      green: "🟢 Grün-Zone — Kontext sauber, kein Handoff nötig.",
      yellow: "⚠ Gelb-Zone — `handoff` erwägen, bevor Recall/Genauigkeit sinken.",
      red: "🔴 Rot-Zone — jetzt `handoff`; der Kontext ist im degradierten Bereich.",
    },
    body: (p) =>
      `Modell ${p.model}: ${p.used} / ${p.window} Tokens (${p.pct}%). ` +
      `Grün ≤ ${p.green}, Gelb ≤ ${p.yellow}, Rot bis ${p.red}.`,
  },
  handoff: {
    selModel: (p) => `Modell ${p.model} (${p.reason})`,
    selVerbatim: (p) => `VERBATIM-FALLBACK (${p.reason})`,
    missingVerbatim: (p) => `⚠ Nicht byte-exakt erhalten: ${p.spans}`,
    result: (p) =>
      `Handoff gespeichert [${p.mode}, Egress=${p.egress}]. Auswahl: ${p.selection}.\n` +
      `${p.holds} Verbatim-Block/Blöcke, ${p.decisions} Decision(s), ` +
      `${p.evidence} Evidence-Eintrag/Einträge → ${p.id}.${p.warn}`,
    verbatimClaim: "verbatim-geschützter Span",
  },
  decisionLog: {
    header: (p) => `${p.count} Entscheidung(en) [${p.view}]:`,
    supersededBy: (p) => ` → ersetzt durch ${p.id}`,
    empty: "Keine Entscheidungen im Store.",
  },
  hostStatus: {
    overviewTitle: "Anmelde-Übersicht:",
    installed: "installiert",
    notFound: "nicht gefunden",
    loginUnknown: "Login: unbekannt",
    loggedIn: "angemeldet",
    noLogin: "kein Login erkannt",
    modelSuffix: (p) => `, Modell ${p.model}`,
    recommendationLabel: "Empfehlung",
    notFoundRec: (p) => `${p.cli} nicht gefunden — bei ${p.cli} anmelden für ${p.altModel} als Alternative.`,
    loggedInRec: (p) => `${p.cli} angemeldet${p.model ? ` (${p.model})` : ""}.`,
    notLoggedInRec: (p) => `${p.cli} installiert, aber kein Login erkannt (best-effort) — ggf. anmelden.`,
    noReadyHost: "Kein angemeldeter Host erkannt — Account-Modus braucht eine angemeldete Host-Session.",
    loginNote:
      "Login-Erkennung ist best-effort (Config-Datei-Präsenz). Installierte CLIs werden " +
      "zuverlässig erkannt; der exakte Login-Status nicht immer.",
  },
  sessionStart: {
    header: (p) => `Cairn — fortgeführter Kontext aus dem Decision-Ledger (${p.count} offen/aktiv):`,
    evidenceNote: (p) => ` (${p.n} Evidence)`,
    briefHeader: "Letzter Handoff-Brief (faithful, nicht zusammengefasst):",
    sourceOfTruth:
      "Dieser Stand ist die Quelle der Wahrheit — NICHT das ganze Repo neu lesen, nur die in NEXT STEPS " +
      'genannten Dateien öffnen. Voller Stand via decision_log (view=current); neuen Brief via "Cairn Handoff" sichern.',
    handoffTitle: "Session-Handoff (7-Bucket-Brief)",
  },
  preCompact: {
    decision: (p) => `Kontext-Compaction (${p.trigger})`,
    rationale: (p) => `Compaction-Event${p.session ? ` · session ${p.session}` : ""}`,
    transcriptTailClaim: "Transkript-Tail (verlustfreier Verbatim-Fallback vor Compaction)",
    systemMessage:
      "Cairn: Host-Compaction erkannt — Ledger gesichert; Cairns Brief wird per SessionStart(compact) " +
      "wieder eingespielt. Tipp: offene Decisions vorher mit `handoff` festhalten.",
  },
  shell: {
    helpLine: "cairn: window | tab | stop | status | list   (andere -> cairn-CLI: install, uninstall, ...)",
    titleRunningPs: "cairn: Zone laeuft im Tab-Titel (PID $($global:CairnTitle.Id)). Stoppen: cairn stop",
    titleRunningPosix: "cairn: Zone laeuft im Terminal-Titel (PID $CAIRN_TITLE_PID). Stoppen: cairn stop",
    titleStopped: "cairn: Titel-Anzeige gestoppt.",
    noTitleActive: "cairn: keine Titel-Anzeige aktiv.",
    noTmux: "cairn: kein tmux/iTerm2 erkannt — nutze 'cairn tab' (Titel) oder starte in tmux. Streifen inline:",
  },
  install: {
    help: [
      "cairn — AI Context Continuity Engine",
      "",
      "Installer:",
      "  cairn install     — verdrahtet Cairn in Claude Code und/oder Codex (idempotent)",
      "  cairn uninstall   — entfernt die Cairn-Einträge wieder",
      "  (mit --lang de|en auf Deutsch oder Englisch installieren)",
      "",
      "Shell-Befehle (nach Install, im Terminal):",
      "  cairn status      — aktueller Codex-Kontext-Zonenstatus (eine Zeile)",
      "  cairn window      — Live-Zonen-Streifen als zweiter Pane (Windows Terminal / tmux / iTerm2)",
      "  cairn tab         — Zone im Terminal-/Tab-Titel · 'cairn stop' beendet sie",
      "  cairn list        — zuletzt aktive Codex-Sessions (mit --session <uuid> pinnen)",
      "",
      "Trigger-Wörter (im Chat sagen — der Agent handelt):",
      '  "Cairn resume"    — Ledger re-injizieren (decision_log view=current) und als Quelle der',
      "                      Wahrheit weiterarbeiten, OHNE das Repo neu zu lesen",
      '  "Cairn Handoff"   — 7-Bucket-Brief aus dem Gespräch verfassen und via handoff persistieren',
      '  "Cairn Help"      — diese Übersicht (Skill cairn-help)',
      "",
      "MCP-Tools (ruft der Agent direkt):",
      "  decision_log      — Ledger lesen/re-injizieren (view=current schlank · view=all volle Historie + Evidence)",
      "  handoff           — 7-Bucket-Brief speichern (Account-Modus = kein Modell-Call/Egress)",
      "  context_status    — Zone 🟢/🟡/🔴 relativ zum aktiven Fenster",
      "  host_status       — welche Host-CLIs eingeloggt sind + aktives Modell",
    ].join("\n"),
    noHost: "Kein Claude Code (~/.claude) und kein Codex (~/.codex) erkannt.",
    noHostHint: "Installiere einen der Hosts und logge dich ein, dann `cairn install` erneut.",
    title: "Cairn install",
    claudeHeader: "• Claude Code:",
    settingsOk: (p) => `  ✓ settings.json — Statusline + SessionStart/PreCompact-Hooks (${p.path})`,
    skillsClaude: "  ✓ Skills → ~/.claude/skills/ (cairn, cairn-handoff, cairn-resume, cairn-help)",
    mcpRegistered: "  ✓ MCP-Server registriert (claude mcp add, scope user)",
    mcpAddFailed: "  ⚠ 'claude mcp add' fehlgeschlagen — bitte manuell ausführen:",
    mcpManual: "  ℹ claude-CLI nicht auf PATH — MCP manuell registrieren:",
    conflictMcp: "  ⚠ Konflikt: ./.mcp.json registriert cairn projekt-scoped auf einen anderen Pfad:",
    conflictScope: "    Projekt-Scope hat Vorrang vor user-Scope → hier griffe der falsche Server.",
    conflictFix: "    Lösung: ./.mcp.json löschen (user-Scope deckt cairn überall ab) oder den Pfad anpassen.",
    codexHeader: "• Codex:",
    codexTomlOk: (p) => `  ✓ config.toml — [mcp_servers.cairn] (${p.path})`,
    agentsAdded: "  ✓ AGENTS.md ergänzt (~/.codex/AGENTS.md)",
    skillsCodex: "  ✓ Skills → ~/.agents/skills/ (cairn, cairn-handoff, cairn-resume, cairn-help)",
    shellHeader: "• Shell:",
    skillSourceMissing: (p) => `  ⚠ Skill-Quelle nicht gefunden (${p.src}) — übersprungen.`,
    shellNoPs: "  ℹ keine PowerShell gefunden — Shell-Befehl 'cairn' übersprungen.",
    shellPsOk: "  ✓ Shell-Befehl 'cairn' (window/tab/status/list) → PowerShell-Profil",
    shellPsHint: "    Neues PowerShell-Fenster öffnen, dann z. B. 'cairn window'.",
    shellPosixOk: (p) => `  ✓ Shell-Befehl 'cairn' (window/tab/status/list) → ${p.path} (+ ~/.zshrc/.bashrc)`,
    shellPosixHint: "    Neue Shell öffnen (oder rc neu sourcen), dann z. B. 'cairn window'.",
    langSet: (p) => `  ✓ Sprache: ${p.lang} (mit CAIRN_LANG pro Session überschreibbar)`,
    doneInstall: "Fertig. Claude Code / Codex neu starten, damit MCP-Server + Hooks greifen.",
    uninstallTitle: "Cairn uninstall",
    settingsCleaned: "  ✓ settings.json bereinigt (Statusline + Hooks entfernt)",
    mcpRemoved: "  ✓ MCP-Server entfernt (claude mcp remove)",
    mcpRemoveManual: "  ℹ claude-CLI nicht auf PATH — ggf. manuell: claude mcp remove cairn --scope user",
    tomlRemoved: "  ✓ config.toml entfernt (war nur der Cairn-Block)",
    tomlCleaned: "  ✓ config.toml bereinigt ([mcp_servers.cairn] entfernt)",
    agentsRemoved: "  ✓ AGENTS.md entfernt (war komplett Cairn-Snippet)",
    agentsCleaned: "  ✓ AGENTS.md bereinigt (Cairn-Snippet entfernt)",
    agentsRemovedLegacy: "  ✓ AGENTS.md entfernt (Legacy-Cairn-Snippet)",
    shellRemoved: "  ✓ Shell-Befehl 'cairn' entfernt",
    doneUninstall: "Entfernt. (Das Ledger unter ~/.cairn bleibt erhalten — bei Bedarf manuell löschen.)",
    langPrompt: "Language / Sprache? [en]/de: ",
  },
  prompts: {
    sevenBucket: [
      "Verdichte den folgenden AI-Chat-Kontext in einen Übergabe-Brief mit GENAU diesen 7 Buckets:",
      "1) DECISIONS — aktuelle Entscheidungen; überholte explizit als 'superseded' markieren.",
      "2) EVIDENCE — Belege mit Quellen-Ref (z. B. msg#NN, Datei, URL).",
      "3) OPEN QUESTIONS — offene Punkte / noch zu klären.",
      "4) CONSTRAINTS — harte Rahmenbedingungen / Zielmetriken.",
      "5) VERBATIM — geschützte Blöcke (Code/IDs/Werte/URLs) BYTE-EXAKT übernehmen, nicht paraphrasieren.",
      "6) NEXT STEPS — konkrete nächste Schritte.",
      "7) DISCARDED — verworfene Sackgassen (knapp).",
      "Regeln: Kein Inhalt außerhalb der Buckets. Nichts erfinden. Marker der Form [[CAIRN-HOLD-n]]",
      "unverändert stehen lassen (sie werden danach byte-exakt zurückgesetzt).",
    ].join("\n"),
    briefOnly: [
      "Du bist ein reiner Verdichtungs-Dienst, KEIN interaktiver Agent.",
      "Gib AUSSCHLIESSLICH den Brief aus — keine Vorrede, keine Meta-Kommentare, keine Erwähnung von",
      "dir selbst, Tools, Repository, Verzeichnis oder MCP-Verbindung. Nutze keine Tools.",
      "Beginne die Antwort direkt mit '1) DECISIONS'.",
    ].join(" "),
  },
};

export const messages: Record<Lang, Messages> = { en: EN, de: DE };

/** Return the message catalog for a language. */
export function t(lang: Lang): Messages {
  return messages[lang];
}
