# Architecture Decision Log — Cairn — AI Context Continuity Engine

> Context-Handoff: condensation and handoff of AI chat context across sessions and models, locally-private, with a proactive context-zone indicator.
> Scope: condensation and handoff of AI chat context across sessions and models, locally-private, with a proactive context-zone indicator.
> Active surfaces: Claude Code / Claude CLI, OpenAI Codex, ChatGPT, local (Ollama).

| ADR | Title | Status |
|---|---|---|
| 0001 | MCP core with a skill/hook skin instead of skill-only or an extension port | Accepted |
| 0002 | Fidelity is the primary goal, cost is a constraint | Accepted |
| 0003 | Context zones relative to the active surface window (40/70/100, provisional) | Accepted |
| 0004 | Summarizer pool restricted to the host ecosystem, with a reachability filter and verbatim floor | Accepted |
| 0005 | Calibration of fidelityScore/verbosityCoeff via a fixed probe context + model peer-review | Accepted |
| 0006 | Condensation via the host agent's account session, not via API keys | Accepted |
| 0007 | Handoff trigger (warn-instead-of-auto) and continuation flow (in-place default) | Accepted |

---

## ADR-0001 — MCP core with a skill/hook skin

### Status
Accepted

### Context
The tool needs (a) persistent decision/evidence storage across sessions *and* models, (b) a context oracle that can be queried at runtime ("where am I, is it about to get dumb?"), and (c) a proactive indicator. These three requirements cannot be satisfied by a pure instruction artifact: a skill is only loaded into the agent context, holds no state, and cannot be queried as a passive service. A browser-based approach (capture/resume via a rendered DOM behind a login) would be coupled to brittle DOM selectors, would break on every UI redesign, is not CLI-portable, and is unnecessary for the target surfaces because the agent harness already holds the conversation. Both main clients speak MCP natively (Claude Code since late 2024; Codex via `~/.codex/config.toml` or `codex mcp add`, including `ollama`/`lmstudio` as built-in providers). The proactive indicator is only fully ambient in Claude Code (statusline JSON with `context_window.used_percentage`, `context_window_size`; `PreCompact` hook), on-demand in Codex (tool call), and only model-invoked in ChatGPT web.

### Options Considered
- **Skill-only**: simple to ship per ecosystem, but no persistent storage, no running service, no cross-session oracle. Fails on (a) and (b).
- **Browser-extension approach (DOM capture/resume)**: would require site adapters but stays DOM/login-coupled, breaks on every UI redesign, and does not fit CLI/agent surfaces. High maintenance cost, wrong surface.
- **MCP core + a thin skill/hook skin per surface**: an MCP stdio server as a local service (token accounting, zone oracle, compaction engine, decision/evidence store in SQLite); a skill as the operating manual; the Claude Code statusline + `PreCompact` hook as the ambient indicator.

### Decision
An MCP stdio server as the core ("brain"), augmented by a thin per-surface skill/hook skin. The skill (`SKILL.md`, working in `.claude/skills/` and `.agents/skills/` or `~/.codex/skills/`) documents when to call the MCP tools `context_status`, `handoff`, and `decision_log`. A browser-based capture/resume/UI approach is explicitly rejected.

### Consequences
- Positive: one core serves all four surfaces plus Ollama plus the generic fallback; persistent local storage is possible; the source conversation comes from the harness, not from fragile scraping.
- Positive: locally-private by design — stdio process, SQLite, no backend; the only egress is the condensation call (ADR-0004).
- Negative: the ambient indicator is surface-uneven (Claude Code full, Codex on-demand, ChatGPT only model-invoked) — this must be communicated openly in the scope.
- Negative: two delivery paths (MCP registration + skill/hook files) increase onboarding complexity.

### Follow-Up
MCP server scaffold (tools `context_status`/`handoff`/`decision_log`) via `mcp-builder` (TypeScript SDK, stdio). Claude Code statusline script + `PreCompact`/`SessionStart` hooks. SQLite schema for an append-only decision/evidence log (ADR-style, with supersession).

---

## ADR-0002 — Fidelity is the primary goal, cost is a constraint

### Status
Accepted

### Context
The quality of the brief determines the entire downstream course of the project. The asymmetry is clear: the saving from a cheaper condensation model is bounded and tiny (cents per session), while the damage from a bad brief is unbounded and cascading (a missing decision or wrongly carried-over evidence poisons every follow-up turn → wrong architecture, rework, a shipped bug). At the same time: "better" must mean *measured-better on the compaction job*, not "more expensive" — reasoning-heavy models sometimes paraphrase more or drift, which is an error for a condensation task. The deterministic verbatim-freeze layer (exact spans masked behind opaque markers, restored byte-exact) secures the verbatim level (code/values/IDs) independently of the model; the remaining model task is the decision/structure/prose level, and that is exactly where a stronger model earns its premium.

### Options Considered
- **Cost-primary (cheapest model above a floor)**: minimizes the bill but risks information loss with unbounded downside.
- **Always the most expensive model**: nominally maximizes quality but burns money in the green zone and may pay 6× for Pro with no measurable fidelity gain.
- **Fidelity-primary with cost as a tiebreaker**: sort by `fidelity_score` (desc); cost decides only within a statistical equivalence band.

### Decision
Compaction fidelity is a primary goal; cost is a constraint, not a goal. The selector sorts by measured `fidelity_score` descending, with a hard floor below which a model is never eligible for condensation. `effective_cost` decides solely as a tiebreaker between models with statistically indistinguishable fidelity. The token-efficiency factor (newer models need fewer tokens for the same result) enters the tiebreak via `effective_cost = price × verbosity_coeff × expected_tokens`, not the primary goal.

### Consequences
- Positive: no penny-pinching risk with unbounded downside; the premium lands on the prose/decision level, where it has effect.
- Positive: at the same time protects against a pointless premium (no 6× Pro when a frontier standard model ties in the measurement).
- Negative: presupposes an empirical calibration (`fidelity_score`, `verbosity_coeff`) — not derivable from vendor docs, must be measured against a golden set.
- Negative: until calibration, selection runs on a provisional, manually set tier ranking.

### Follow-Up
Create a golden set of representative chats; condense once per model; score output tokens and fidelity against a reference brief → populate `fidelity_score` + `verbosity_coeff`, set `calibrated: true`. Set the floor value after the first measurement.

---

## ADR-0003 — Context zones relative to the active surface window

### Status
Accepted (provisional)

### Context
Vendors do not publish hard percent thresholds for quality degradation. Anthropic names Context Rot officially in the context-windows documentation ("as token count grows, accuracy and recall decline") and recommends compaction, without % zones. Independent benchmarks (Chroma Context Rot, RULER, MRCR) confirm continuous, model-dependent degradation well before the window is full. The actually available window also depends on the surface (Opus 4.8: 1M on API/Bedrock/Vertex, but 200K on Microsoft Foundry; GPT-5.5 in Codex hard-capped at 400K). Noisy tool/search workloads degrade earlier than clean document chats (Anthropic's own eval harness compacts agentic search as early as 50K).

### Options Considered
- **Fixed token threshold per model**: ignores the surface-dependent window and the use case.
- **Percentages relative to the model maximum only**: wrong when the surface caps the window (Foundry 200K, Codex 400K).
- **Percentages relative to the active window, plus a use-case factor**: zones as `(model, window, use case)`.

### Decision
Zones are computed as a percentage of the *active window determined at runtime* (`min(model_max, surface_cap, user_override)`), not of the model maximum. Starting values for Opus 4.8 and GPT-5.5 @1M: green 0–40 %, yellow 40–70 %, red 70–100 %, status `provisional` with source "internal, pending vendor benchmark". Smaller windows inherit the same percentages until their own numbers are available. A `noise_factor` per use case compresses the boundaries for tool/search-heavy sessions. When official vendor numbers become available, they replace the provisional values (versioned, with a date).

### Consequences
- Positive: correct across all surfaces (Foundry 200K, Codex 400K, Claude Code 1M) with no special cases in the caller.
- Positive: the cost thresholds (272K surcharge on GPT-5.x; flat on Opus 4.8/Sonnet 4.6) are separable as a second, hard-backed dimension (`cost_zone`) from the quality zone.
- Negative: 40/70/100 is provisional and not externally backed; for noisy workloads it may be too optimistic (Anthropic 50K signal).
- Negative: inheriting the same percentages onto smaller windows is a simplification (small windows may degrade differently in percentage terms).

### Follow-Up
The `context_status` tool reads the live window (Claude Code statusline JSON / Codex cap / Foundry) and computes the boundaries. Define a `noise_factor` per use-case profile. Carry provisional zones marked as `provisional`; review once RULER/Chroma numbers for Opus 4.8 / GPT-5.5 are available.

---

## ADR-0004 — Summarizer pool restricted to the host ecosystem, with a reachability filter and verbatim floor

### Status
Accepted

### Context
Not every user has access to every model: a Claude user does not necessarily have a ChatGPT account. When the tool runs in Claude Code/CLI, only models provided by Anthropic may be referenced, and analogously on the OpenAI side. Availability is even finer than the ecosystem: the 1M window is Tier-4+-gated, a plan may have only Haiku/Sonnet, an API key may be scoped. Because the MCP server makes the LLM call (not the host agent), it could technically call any provider for which credentials exist — and that is exactly what must be prevented. A lightweight credential/capability probe per candidate is the right building block for a real reachability check. (In account mode — the default, see ADR-0006 — the host makes the call; "reachability" then means: can the active account session invoke this model.)

### Options Considered
- **Global model pool**: ignores missing access; would pick models the user cannot call.
- **Static ecosystem table without a probe**: filters coarsely but does not catch tier/scope/plan limits.
- **Ecosystem filter + reachability probe + verbatim fallback below the floor**: a four-stage pipeline.

### Decision
The summarizer candidate pool is restricted to the host system's ecosystem and additionally filtered to credential-reachable models (capability/key probe per candidate). Cross-provider routing only with explicit org configuration. Selection pipeline: (0) detect environment → (1) filter to ecosystem → (2) check reachability → (3) rank quality-first (ADR-0002) with zone escalation (ADR-0003: red/yellow → top model, no cost downgrade) → (4) floor check. If the best available model is below the fidelity floor, the brief is delivered **verbatim instead of compressed** (lossless verbatim fallback). Ollama local is the only universal, account-free fallback and fits the locally-private approach, but must be calibrated separately.

### Consequences
- Positive: closes the gap "Claude user without a ChatGPT account"; never selects a model that cannot be called.
- Positive: consistent with ADR-0002 — better a longer, complete verbatim handoff than a short, wrong brief.
- Positive: for CGI the Bedrock EU path is the obvious way to use the whole Anthropic set fidelity-first without leaving the ecosystem.
- Negative: the reachability probe costs one lightweight test call each and must be cached so as not to strain latency/rate limits.
- Negative: host-native self-compaction (subagent) only gets the session model, so it cannot deliberately choose a more faithful sibling.

### Follow-Up
Environment detection (Claude Code `model.id` / Codex `model_provider`) as stage 0 before the selector. Reachability probe (cached) per candidate. `ecosystem` field + `availability` status into the `model-profiles` schema. Wire the verbatim fallback path into the `handoff` flow.

---

## ADR-0005 — Calibration of `fidelityScore`/`verbosityCoeff` via a fixed probe context + model peer-review

### Status
Accepted

### Context
`fidelityScore` and `verbosityCoeff` (ADR-0002) are not derivable from vendor docs and are `provisional` in the `model-profiles` schema to date. Without measured values, the quality-first selection is only coarse, and the verbatim floor (ADR-0004) has no solid basis. Models appear on a ~6-week cadence (Opus 4.7→4.8 in 41 days; GPT-5.6 announced), prices change — a one-time measurement goes stale quickly.

### Options Considered
- **Manual expert estimate**: fast, but subjective, not reproducible, stale immediately.
- **Static benchmark adoption (RULER/MRCR)**: measures retrieval, not compaction fidelity on the concrete 7-bucket task; provides no verbosity signal.
- **Own reproducible calibration run**: a fixed probe context, identical for all models, is condensed by every candidate; the briefs are scored via model peer-review against a rubric.

### Decision
`fidelityScore`/`verbosityCoeff` are determined by a reproducible calibration run:
1. A **fixed probe context** (identical for all models) with a curated **ground-truth key** (mandatory facts, decisions, evidence that must survive in the brief).
2. Each candidate condenses the same context with the same 7-bucket prompt.
3. `verbosityCoeff` = the brief's output tokens relative to the median of all candidates (objective, no review needed).
4. `fidelityScore` = rubric-based **peer-review** by the strongest *available* foreign models (no self-review), normalized to 0..1. Rubric: recall of the ground-truth items, hallucinations, supersession correctness, verbatim fidelity of the protected blocks.
5. **Cross-ecosystem is allowed only in calibration** (offline at CGI with keys for both worlds), never in the live selector (ADR-0004 remains untouched). Scores are thus measured globally comparable, but in operation are applied only within the reachable pool.
6. Re-run on every new model or price update; results versioned with a date. A new model starts `provisional` until it has run through the probe once; then `calibrated: true`.

### Consequences
- Positive: closes the last hand-wave spot — the quality-first selection and the floor stand on measured data.
- Positive: the same `provisional → calibrated` mechanism as for price/zone data; consistent data maintenance.
- Positive: delivers the prompt iteration that Anthropic requires anyway ("tune on complex traces") as a by-product.
- Negative: reviewer bias — stronger models may favor their own style. Mitigation: ≥2 reviewers per brief, averaging, record the spread as a confidence measure.
- Negative: ongoing maintenance effort (re-run per model/price update) and the cost of the calibration calls.

### Follow-Up
Implement the calibration harness (see `docs/calibration-spec.md` and backlog ticket T3): create the probe context + ground-truth key, condensation runner, peer-review rubric, score normalization, writer into the `model-profiles` schema. Set the floor value after the first complete run.

---

## ADR-0006 — Condensation via the host agent's account session, not via API keys

### Status
Accepted

### Context
End users work with **Codex and Claude via their own accounts/subscriptions**, not with API keys. The LLM usage for compacting should run via the same account session. From this it follows necessarily: by default the MCP server has no credentials and must not make the condensation call itself against a provider API — the call must be delegated to the host, which is already signed in. This touches the earlier implicit assumption (server calls the API with a key) from ADR-0002/0004.

### Options Considered
- **Server calls the provider API with key/Bedrock**: presupposes credentials the account user does not have; violates the requirement and creates unnecessary egress.
- **Host self-compaction (skill + hook)**: the host agent produces the brief in-session with the account model; Cairn only stores/structures. No credentials, no server-side model call.
- **MCP sampling**: the server requests a completion from the client via `sampling/createMessage`, which executes it on the user account. Clean, but client-dependent (support in Claude Code/Codex not confirmed).
- **Agent-as-MCP-server bridge**: to use the respective other account (Codex as an MCP server or a Claude Code wrapper). Documented, but heavier-weight.

### Decision
The LLM call for condensation runs via the **host agent's account session**, not via API keys. Modes by priority:
1. **Default — host self-compaction:** the host (Claude Code via the `PreCompact` hook + skill; Codex via skill/AGENTS instruction) produces the 7-bucket brief in-session. Cairn then runs the deterministic `freezeVerbatim` masking + validation on it and persists via `decision_log`. The Cairn server makes **no** model call and needs **no** credentials.
2. **Optional — MCP sampling:** where the client supports it, the server requests the completion from the client (runs on the user account). Check as a capability, do not presuppose.
3. **Optional — bridge:** for the respective other account (e.g. Claude orchestrates, Codex condenses on the ChatGPT account).
4. **Optional — API/Bedrock:** only for headless/automated org runs; requires explicitly configured credentials.

Consequence for the selector (ADR-0002/0004): in account mode the candidate pool = the models the **active host session/the account can invoke** (in Claude Code, among others, via subagents with a selectable model from the `availableModels` allowlist). "Reachability" means account/session capability, not the presence of an API key. The per-token price is secondary in account mode (flat subscription); the relevant scarcity is the **account usage/rate limit**. `effectiveCost` remains for the optional API path and as a relative efficiency measure, but is informational in account mode.

### Consequences
- Positive: maximally locally-private — by default no content leaves the host, the server needs no keys at all.
- Positive: no separate billing/key management for end users; they use what they already pay for.
- Negative: the free model choice for condensation is limited in account mode to what the session/the account offers (fidelity-first acts only within this pool, possibly via subagent model choice).
- Negative: compaction consumes the user's account usage budget — frequency/triggers must respect this (don't fire immediately in every yellow zone).
- Negative: sampling support is client-dependent and currently unconfirmed; the default must not depend on it.

### Follow-Up
`host_status` check (backlog T1): at startup, detect which host CLIs are installed/reachable/signed-in (best-effort), which model the active session runs, and print a sign-in overview. Build `handoff` so that it accepts and stores a **host-produced brief** (default), with sampling/bridge/API as optional modes. Egress guardrail: in default mode, no server-side model call.

---

## ADR-0007 — Handoff trigger (warn-instead-of-auto) and continuation flow

### Status
Accepted

### Context
ADR-0001/0006 establish the MCP core + account mode. Open was: what happens concretely on a zone transition, and what is the result — only a brief or a new session? An MCP server is **passive**: it acts only on a tool call, cannot push a message into the chat on its own, and cannot open an interactive user session. "Proactive" emerges from the interplay of the statusline (ambient, Claude Code only), the skill (makes the agent capable of acting), and the PreCompact hook (safety net). Condensation consumes account usage budget (ADR-0006) → it must not fire unprompted in every yellow zone.

### Options Considered
- **Auto-compact at a threshold**: consumes budget unprompted, interrupts the user mid-thought.
- **Purely manual**: does not fulfill the "proactive" goal.
- **Warn-instead-of-auto + safety net**: the statusline warns advisory; the user triggers at the natural break; PreCompact catches the ignore case.

### Decision
**Trigger:**
- **Yellow (≥40 % of the active window):** the statusline turns yellow + an advisory hint (e.g. `⚠ 47% — degraded zone approaching, handoff at the next break`). **No output, no budget consumption.** Purely advisory.
- The user triggers the handoff at the natural break themselves (slash command or a request to the agent).
- The handoff runs in a **compaction subagent** (worker), not in the main context — so the condensation reasoning tokens do not bloat the main context. The subagent produces the 7-bucket brief with the account model, `freezeVerbatim` secures the exact spans, the result goes into the decision/evidence ledger; the subagent context is discarded afterwards.
- **Red (≥70 %):** a stronger hint; the selector escalates to the strongest available model in the account pool (ADR-0002/0003).
- **Safety net:** if the user ignores everything and the *host-native* auto-compaction fires near the limit, then Cairn ensures that its structured brief **survives** the compaction — instead of relying on the host's lossy default summary. Mechanism: `PreCompact` detects the event and secures it (record + verbatim-tail snapshot into the ledger); the **`SessionStart` hook with the matcher `compact`** (or `PostCompact`) re-injects the brief from the ledger into the ongoing context directly **after** the compaction. This is the **only automatic action**, and it is triggered by the host compaction event, not by Cairn alone.

> **Correction (2026-06-22):** The original version wrote that the `PreCompact` hook "slips the brief in as the compaction summary". That is technically not feasible — the `PreCompact` hook has no field to provide/replace the summary, and its `additionalContext` is part of the context to be compressed (gets summarized along with it). Backed by the official hooks documentation + claude-code#14258. The path that actually works is `SessionStart`(`compact`)/`PostCompact` **after** the compaction (which is not summarized). The intent (brief survives in-place instead of a lossy host summary) is unchanged; only the hook mechanism is corrected.
- There is **no native "automatic at 70 %" hook**; 70 % is shown ambiently. In Codex/ChatGPT the statusline is missing → the agent checks `context_status` (instructed via AGENTS.md) and reports on-demand.

**Continuation (the result):**
- Always: brief produced **and** persisted to the ledger (the durable artifact).
- **Default — in-place:** immediately after the host compaction, the `SessionStart`(`compact`) hook re-injects Cairn's brief from the ledger, so that the **same session continues cleanly**. **No** new session. (See the correction above: the brief does not replace the host summary, but is replayed faithfully *after* it.)
- **Optional — fresh:** the brief is persisted; the user starts a new session or `/clear`; the `SessionStart` hook re-injects the brief → the new context starts pre-populated.
- **Optional — cross-model:** the model-agnostic ledger seeds a session in the *other* host (Claude ↔ Codex via bridge). The actual USP.
- **Clarification:** Cairn pops up **no** new interactive user session (an MCP server cannot). It ensures that the *next* session the user starts comes up pre-populated (SessionStart re-injection), or it drives the bridge headlessly. Subagent ≠ new user session — the subagent only computes the brief cheaply, the new session is the user's choice.

### Consequences
- Positive: respects the account budget, does not interrupt the user, isolates the reasoning tokens in the subagent.
- Positive: "continue in-place" is the smoothest path; "fresh" and "different model" remain deliberate options.
- Negative: "ambient proactive" is only possible in Claude Code; in Codex/ChatGPT it is on-demand.
- Negative: no real threshold auto-trigger except via host compaction (PreCompact).

### Follow-Up
Tickets **T4** (statusline script + `PreCompact`/`SessionStart` hooks) and **T5** (compaction subagent + continuation flow). Both after T1/T2.

## ADR-0008 — Ambient zone indicator for Codex via rollout tailing

### Status
Accepted — supplements ADR-0001/ADR-0003 (Codex was "on-demand only" there).

### Context
ADR-0001/0003 held that the ambient indicator was only possible in Claude Code, because Codex
has no statusline API and feeds no hook with the token count. New finding: Codex writes
a `token_count` event with `info.last_token_usage` and `info.model_context_window` per turn into
`~/.codex/sessions/<date>/rollout-*.jsonl`. The token count is thus readable out-of-band.

### Options Considered
- **A — status quo (on-demand `context_status` only):** robust, but no ambient warning.
- **B — rollout tailing + render into the terminal title/tmux (chosen):** a stateless reader reads the
  rollout file, uses the existing zone logic, renders into the title or the multiplexer status bar.
  Zero new deps. Couples to a Codex-internal file format.
- **C — experimental `app-server`/`remote-control` websocket:** the "most official" live state,
  but experimental + significantly more effort → later (follow-up).

### Decision
We build B: a read-only rollout reader (`src/surface/codex-rollout.ts`) + a one-shot bin
`cairn-codex-status` + an optional `cairn-codex-watch` (OSC title). No new dependency; the
zone computation remains the existing one (`renderStatusline`/`activeWindow`/`zoneBoundaries`).

### Consequences
- Positive: an ambient zone indicator in Codex too; full reuse of the zone core; no
  egress, no model call, no credentials; zero deps.
- Negative: coupling to Codex's rollout format (private, unversioned) — can break with Codex releases.
  Mitigation: defensive parsing (tolerate missing fields/events), treat the format as
  `provisional`, do NOT pull it into the MCP core (deliberately only an out-of-band reader, unlike
  the DOM scraping in the product path rejected by ADR-0001).
- Negative: `usedTokens` is a snapshot of the last turn (no live update between turns);
  definition validated (see follow-up).

### Follow-Up
Ticket T6. **Validated (2026-06-23)** against real `~/.codex/sessions` rollouts (gpt-5.5 @ window
258400; >13,000 `token_count` events): the actual window occupancy is
`last_token_usage.total_tokens` (= input + output), **not** `input_tokens` alone. Evidence: across the
turn progression, `input_tokens(N+1) ≈ total_tokens(N)` (delta small, only new user/tool input),
i.e. the produced output (incl. reasoning) rolls fully into the next request — for
reasoning-heavy turns several thousand tokens. `usedTokens` therefore set to `total_tokens` (fallback
`input_tokens(+output_tokens)`); `cached_input_tokens` is a subset of `input_tokens` and is
not added. Check the `app-server` path (option C) once it is stable/documented.

## ADR-0009 — Installer sets up shell shortcuts (`cairn window`/`tab`)

### Status
Accepted — builds on ADR-0003 (surface) and ADR-0008 (Codex ambient).

### Context
The ambient Codex indicator (ADR-0008) was reachable only via long `node …/cairn-codex-*.js` calls.
For a good onboarding UX, all users should get convenient shell commands via the installer
(`cairn window`/`tab`/`status`/`list`). Tricky: the name `cairn` collides with the existing
`cairn` bin (server/installer CLI), and the installer would for the first time write into the user's
**shell profiles** — cross-platform (Windows + macOS + Linux).

### Options Considered
- **A — docs only** (`ambient-zone.md`): no intervention, poor UX.
- **B — a dedicated command name** (e.g. `czone`): no conflict, but not the desired `cairn window`.
- **C — a `cairn` function, UI subcommands handled itself, the rest forwarded to the bin (chosen).**

### Decision
C. The self-installer merges a `cairn` shell function idempotently into the user profiles, between
the markers `# >>> cairn >>>` / `# <<< cairn <<<`; `uninstall` removes it exactly.
- **Windows:** a PowerShell function into `$PROFILE.CurrentUserAllHosts` (pwsh + 5.1 if present,
  path determined via the CLI → OneDrive-safe). `window` = `wt -w 0 split-pane`, `tab` = OSC title.
- **macOS/Linux:** a POSIX function in `~/.config/cairn/cairn.sh`, sourced from `~/.zshrc`/`~/.bashrc`.
  `window` cascades tmux → iTerm2 → Terminal.app → inline; `tab` = OSC title (any terminal).
- Unknown subcommands (`install`, `uninstall`, …) → `node <dist>/server.js …`.

### Consequences
- Positive: `cairn window/tab/status/list` out-of-the-box, no path typing; pure reuse of the
  existing bins; no egress/model call.
- Negative: the installer writes into shell profiles for the first time → markers + an exact `uninstall`
  roundtrip are mandatory; the OneDrive path pitfall (→ path via the CLI). The function shadows the `cairn` bin →
  forwarding is mandatory.
- Negative: macOS `window` is terminal/multiplexer-dependent (tmux & iTerm2 reliable, Terminal.app
  via `do script`); `tab` (title) is the everywhere-working anchor. Interactive macOS behavior
  remains `provisional` until the Mac smoke test.

### Follow-Up
Ticket T7. Smoke-test the macOS paths on a Mac (tmux split, iTerm2 split, Terminal.app `do script`,
`cairn tab` title).
