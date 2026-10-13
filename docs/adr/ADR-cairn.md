> **Current invocation policy: ADR-0010 below supersedes automatic triggers and hooks in earlier ADRs.**

# Architecture Decision Log — Cairn — AI Context Continuity Engine

> Context-Handoff: condensation and handoff of AI chat context across sessions and models, locally-private, with a proactive context-zone indicator.
> Scope: condensation and handoff of AI chat context across sessions and models, locally-private, with a proactive context-zone indicator.
> Active surfaces: Claude Code / Claude CLI, OpenAI Codex, ChatGPT, local (Ollama).

| ADR | Title | Status |
|---|---|---|
| 0001 | MCP core with a skill/hook skin instead of skill-only or an extension port | Accepted; hooks superseded by ADR-0010 |
| 0002 | Fidelity is the primary goal, cost is a constraint | Accepted |
| 0003 | Context zones relative to the active surface window (40/70/100, provisional) | Accepted |
| 0004 | Summarizer pool restricted to the host ecosystem, with a reachability filter and verbatim floor | Accepted |
| 0005 | Calibration of fidelityScore/verbosityCoeff via a fixed probe context + model peer-review | Accepted |
| 0006 | Condensation via the host agent's account session, not via API keys | Accepted |
| 0007 | Handoff trigger and continuation flow | Invocation/hooks superseded by ADR-0010 |
| 0008 | Ambient zone indicator for Codex via rollout tailing | Accepted |
| 0009 | Installer sets up shell shortcuts (`cairn window`/`tab`) | Accepted |
| 0010 | Cairn runs only on explicit user requests | Accepted |
| 0011 | New model generations: full profiles, context-only entries, pinned calibration ids | Accepted |
| 0012 | Summarizer pool = current generation; calibration at effort `high` with a full reviewer matrix | Accepted |
| 0013 | Grounded briefs: quotes for what was said, (derived) for inference | Accepted |

---

## ADR-0001 — MCP core with a skill/hook skin

### Status
Accepted; its hooks are superseded by ADR-0010.

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

> **Correction (2026-10-12, ADR-0012):** Zone escalation is a raised floor, not a switch to the top model. The selector takes the top fidelity band (at most 0.02 below the best reachable model) and sorts it by cost; the zone raises the floor (yellow +0.05, red +0.10). The cheapest band model that clears the raised floor is selected, and the selection falls back to verbatim only when no band model clears it. Cost therefore decides inside the band in every zone; a model outside the band is never chosen for its price. Until 2026-10-12 the floor was checked only on the cheapest band model, so a stronger band model was skipped in favor of verbatim. The selection does not pick the writer: the session model writes the brief in every mode (an API endpoint's configured model, or the bridge CLI's default where the session model does not run), and the selection is a recommendation (ADR-0012).

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
- Negative: reviewer bias — stronger models may favor their own style. Mitigation: several foreign reviewers per brief (since ADR-0012 the full matrix: every other pool model), averaging, record the spread as a confidence measure.
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
Accepted; invocation and hooks are superseded by ADR-0010.

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

  > **Correction (2026-10-12, ADR-0012):** In red the selector raises the fidelity floor by 0.10 (ADR-0004, corrected); it does not switch to the strongest model. The calibrated picks, Claude Opus 5.5 and GPT-6.1 Sol, clear that floor, so they are selected in every zone.

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

## ADR-0010 — Cairn runs only on explicit user requests (2026-09-30)

Accepted. Supersedes automatic invocation and hook behavior in ADR-0001/0007; the ledger,
account mode, verbatim preservation and passive status displays remain unchanged.

Repeated task-start resumes and task-end handoffs add unnecessary tokens and context.
Only an explicit user request permits the corresponding action: Cairn Handoff, Cairn resume,
Cairn Help, or a requested status inspection. Quoted commands are not invocations. One action
does not enable future automation. Help does not call tools; resume does not trigger handoff.
Session/task boundaries, yellow/red zones, compaction, clearing and host/model switches never
authorize an action. Status displays are informational and do not inject prompts.

All shipped skills disable implicit invocation using host-specific metadata. The installer
refreshes the marked AGENTS block, copies that metadata, and removes only Cairn's legacy
SessionStart/PreCompact commands, preserving unrelated commands in shared hook entries.
Plugin/manual templates have no automatic hooks. Old hook binaries remain silent no-ops so
stale registrations neither access the ledger/transcript nor inject context after updating.

Existing users update, build and re-run the installer, then restart their host. New installs
receive these defaults. No ledger records are deleted or automatically rewritten.

---

## ADR-0011 — New model generations: full profiles, context-only entries, pinned calibration ids (2026-10-11)

Accepted. Extends ADR-0003/0004/0005; zone fractions, selection and the fidelity floor are unchanged.

Claude Opus 5.5 gets a full profile (window, max output and prices from Anthropic's docs) and
joins selection and calibration. Until a live calibration run measures it, it is uncalibrated
and ranks on the Opus seed prior (0.92), so it never displaces a calibrated pick on a guess.
Every other current model gets a context-only entry. Only its window and max output are sourced; its
zones are the shared provisional house values. Current means three groups: Anthropic's current lineup
(models overview); the "Flagship models" section of OpenAI's API models overview; and GPT-6 Sol, which
Codex names as the GPT-5.5 replacement on Plus, Pro, Business, Enterprise and Edu plans ("when
available"). `resolveProfile` uses these entries, so
the statusline and `context_status` show the real window instead of the 128K generic fallback.
Selection and calibration never use them because they have no sourced price and no fidelity.
An entry becomes a full profile when its model gets full support.

Id resolution treats only real snapshot dates (`yyyymmdd`, `yyyy-mm-dd`) as an omitted suffix.
A version step such as `claude-opus-5` (Opus 5) therefore never resolves to `claude-opus-5-5`,
and `claude-opus-4` (Opus 4, 200K) no longer borrows the 1M Opus 4.8 profile.
The Claude Code statusline reads the window from the documented `context_window.context_window_size`
and usage from `total_input_tokens`/`current_usage`; the legacy shape is still accepted. For a model
without a profile, the generic 128K is a placeholder rather than a model maximum, so an explicit window
(host-reported or user override) replaces it in `min(model_max, surface_cap, user_override)`. Without
one it stays 128K. Zero, negative and non-finite window values count as absent.

Calibration passes the full model id to `claude --model`. Claude Code's family aliases move to
the newest model (`opus` = Opus 5.5 on the Anthropic API), so an alias would calibrate one model under another
model's name, and would let a model peer-review itself under a different label. Claude Code
maps a full id to the provider's id on Bedrock, Google Cloud and Mantle where the provider supports
that version. A pinned id that cannot run
(e.g. a Foundry deployment neither named after the model nor mapped by `modelOverrides`) fails, and the variant is skipped and logged
rather than mislabeled.

---

## ADR-0012 — Summarizer pool = current generation; calibration at effort `high` with a full reviewer matrix (2026-10-11)

Accepted. Extends ADR-0004/0005/0011. Zones are unchanged. The selection checks the floor over the whole
band ("Band rule" below), and the fidelity floor moves from 0.85 to 0.84 with the calibration (see
"Calibration result"). The reviewer rule of ADR-0005 (≥2
strongest foreign reviewers) becomes a full matrix.

**Context.** Until now the calibrated pick on Claude hosts was Claude Haiku 4.5. Anthropic dates its
retirement "not sooner than October 15, 2026". GPT-5.5 leaves ChatGPT and Codex on 2026-10-14 (the
OpenAI API keeps it); GPT-5.4 left Codex with ChatGPT sign-in on 2026-08-31. Claude Opus 5.5 was the only
full profile of the current generation, and it was uncalibrated.

**Pool.** The summarizer pool is exactly the current generation, as full profiles sourced from the vendor
docs on 2026-10-11 and checked by two independent reviews: Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and
Haiku 5.5 on Claude hosts; GPT-6 Astra, GPT-6.1 Sol and GPT-6 Luna on Codex hosts. Haiku 5.5 is the only
Claude model with a long-context tier: a request over 100,000 prompt tokens pays 5x on everything, Batch
included (`stdThreshold: 100_000`, surcharge 5/5). The GPT-6 models follow GPT-5.5's rule: above 272K input
tokens 2x input and 1.5x output for the whole request, Batch included. `gpt-6-sol` stays a context-only
entry.

**Suspended.** Opus 4.8, Sonnet 4.6, Haiku 4.5, GPT-5.5, GPT-5.5 Pro, GPT-5.4 and GPT-5.4 Pro are
`suspended`, and Fable 5 stays suspended (Anthropic lists it as a legacy model, still available). Their
measured values stay as history. They still resolve, so the statusline and `context_status` keep the
right window (Opus 4.8 1M, Haiku 4.5 200K, GPT-5.5 1,050,000), but they are never selected, calibrated
or used as reviewers.

**Before the calibration.** The new profiles started uncalibrated with house priors (`provisionalFidelity`,
kept in the profiles as history): Fable 5.1 0.93, Opus 5.5 0.92, Sonnet 5.5 0.85, Haiku 5.5 0.70, GPT-6
Astra 0.93, GPT-6.1 Sol 0.92, GPT-6 Luna 0.70. With the 0.85 floor that gave Opus 5.5 / GPT-6.1 Sol in
green and yellow and verbatim in red. The calibration below replaces it. In the sampling, bridge and API
modes the configured caller compacts even when the selection reports "verbatim fallback" and stores the
model's brief, and account mode stores the host's brief, so the fallback is only reported. That predates
this ADR (a bridge test requires the call) and stays an open point; which model compacts is described
under "Who writes the brief" (the session model).

**Effort.** Every model is calibrated at exactly `high`, and Cairn never requests less for a calibration
or bridge call. The bridge silently drops an effort it does not accept, and the CLI then uses its default:
`medium` for Opus, Sonnet and Haiku 5.5 in Claude Code, and GPT-6 Astra's default is not documented. So
the floor is enforced before the call, in four places: `buildVariants`; the account compactor right after
`parseVariant` (a violation becomes a logged skip without a call); `makeModelReviewer` when the reviewer
is created (exactly `high`); and the CLI's live paths (`resolveCalibConfig` + pre-flight: candidates
exactly `high`, reviewers exactly `high`, pool models only, suspended ids rejected). `parseVariant` and
`runBridge` stay generic, so offline paths keep working.

In Claude Code, `CLAUDE_CODE_EFFORT_LEVEL` outranks `--effort`, and an `env` block in a settings file
outranks the shell. So for a documented level the claude bridge pins the requested effort three ways:
`--effort`, the child's environment, and `--settings '{"env":{"CLAUDE_CODE_EFFORT_LEVEL":…}}'`, which
outranks user settings. It also passes `--setting-sources user`: its cwd is the shared tmpdir, and
project or local settings found there (hooks, `env`, effort caps) are never the user's. The same
`--settings` turns off user and plugin hooks (`disableAllHooks`): a compaction or review needs none, and
a prompt or agent hook with its own model would run that model inside the call. Managed hooks, built-in
mods, hooks of plugins that managed `enabledPlugins` forces, and a managed `disableAllHooks: false` still
apply; if such a hook runs a model other than the one being calibrated, the model check below skips
that run (none is mis-credited). Codex gives `-c`
overrides the highest precedence, and the bridge ignores the user config. A calibration call also checks
which model answered: claude reports per-model output in `modelUsage`. A configured `fallbackModel` chain
or the automatic switch after a refusal lets another model answer; the requested one then shows no
output, partial output (a refusal mid-stream) or is missing. Unless the requested model alone produced
output, the brief or review is skipped, not credited to the requested id; so is a run where any other
model produced output, such as an auxiliary model. When no model reports output (a gateway that sends no
usage), the listed models decide: another model listed, or the requested one missing (also an empty
`modelUsage`), is a fallback too. A claude result without `modelUsage` at all is not checked; Claude
Code 2.1.296 always reports it (`{}` on errors).
(Claude Code's server-side fallback is listed only with usage, which the Anthropic API always sends.)
An error result is skipped as well: claude `is_error` (an API error, or a refusal mid-stream without a
fallback; also in the array form `verbose` output takes), whose text is the error message, an `error_*`
subtype (also with `is_error: false`), output that is neither a JSON object nor a JSON array (also with
exit 0), JSON without a result (a result that did not fail without a string `result`, an array without a
`result` event), or any claude output with a non-zero exit; a failed result without a `result` text
carries its `errors` messages as text; and for Codex a `turn.failed` event, an `error` event that no
`turn.completed` follows (codex also reports retried stream errors as `error`), or a non-zero exit,
whose text is at most a partial answer. A failed Codex run without an answer makes the bridge call fail,
with Codex's error message (which it writes to stdout only) as the reason: the latest non-empty
`turn.failed` message or `error` message that no `turn.completed` follows, else stderr. A skipped brief
is labelled "context exceeds window" only for a claude JSON error result whose text matches a window
message ("prompt is too long", "context window" …), never for output that is neither a JSON object nor a
JSON array or a Codex run's partial answer, which may be a brief that mentions a context window; a JSON
result that failed only by its exit code is still read this way, though its `result` may be an answer
(only the label is wrong then, the brief is skipped either way). `modelUsage` keys are the Anthropic
model ids Claude Code resolved, not what it sent upstream, so a redirect (`modelOverrides`, a gateway
behind `ANTHROPIC_BASE_URL`) stays invisible to this check. `codex exec --json` names no model, except
for a safeguard reroute, which it reports as an error item `model rerouted: <from> -> <to>`; such a run
counts as answered by `<to>` and is skipped (a dated form of the requested model is the same model).
Codex may drop that notice under backpressure (it is not a guaranteed notification), so this check is
best-effort. A Codex error message never becomes the answer text. The product bridge does not check the
model.

**Context isolation.** A bridge call (compaction, calibration brief or review) should see only its
system prompt and its input, plus what the CLI itself adds. For claude that is a billing header, an
identity line and an environment block: cwd, git flag, platform, shell, OS, model and knowledge cutoff,
token budget, date, and a note on downloaded files. For Codex it is its base instructions plus its
permissions, collaboration-mode and environment context. Depending on account or config, Codex can add
more: a git-attribution block (ChatGPT login with commit attribution on, no switch), memories, or
managed developer instructions. Two independent reviews ran Claude Code
2.1.296 offline against a mock API and read the Codex `rust-v0.162.1` source. They found gaps the
earlier flags left open, all of them older than this ADR:
- `--tools ""` disables built-in tools only. User-scope and plugin MCP servers started on every call.
  Their tools went to the model and ran under a matching allow rule.
- The user's `~/.claude/CLAUDE.md` was injected, and every call left a session transcript.
- For Codex, `--ignore-user-config` skips the user's `config.toml`, profiles and environments. Still
  loaded:
  - the first non-empty of `$CODEX_HOME/AGENTS.override.md` and `AGENTS.md`;
  - the skills catalog from every skill root, e.g. `$CODEX_HOME/skills`, `~/.agents/skills`,
    `/etc/codex/skills`, a repo's `.agents/skills`, plugin and bundled skills;
  - a project `AGENTS.md` in the cwd.

The claude bridge now passes:
- `--strict-mcp-config` without `--mcp-config`, so no MCP server starts. It is left out when a
  `managed-mcp.json` exists at the documented path (`/etc/claude-code/`,
  `/Library/Application Support/ClaudeCode/`, `C:\Program Files\ClaudeCode\`). With a valid file
  Claude Code exits at startup on the flag. With an invalid one, Claude Code 2.1.296 keeps exclusive
  control as well. Either way only the documented managed set loads, never user or plugin servers.
  For an unreadable or invalid file this relies on that fail-closed behaviour of 2.1.296. Were a later
  version to treat such a file as absent, user and plugin servers would start again, with their tools
  still denied.
- `--disallowedTools mcp__*`, which removes every MCP tool, but not a loaded server's instructions;
- `--no-session-persistence`;
- `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `ENABLE_CLAUDEAI_MCP_SERVERS=false`, set both in the child's
  environment and in the `--settings` `env`;
- `disableClaudeAiConnectors: true`, also in `--settings`.

The codex bridge adds:
- `-c skills.include_instructions=false`;
- `-c project_doc_max_bytes=0`;
- `-c features.apps=false`;
- `-c agents.enabled=false` and `-c features.multi_agent_v2=false`. Together they remove the
  multi-agent tools (`spawn_agent` …) and their instructions. GPT-6's catalog switches them on, and
  they could start further, uncounted model calls. `multi_agent_v2` would win over `agents.enabled`
  from any config layer, hence both.
- `--ignore-rules`. Without it, the user's execpolicy rules load as well, 877 allowed command
  prefixes in the 4b' rollouts, and a command matching an allow rule runs outside the read-only
  sandbox. The flag drops the user and project rules entirely, forbid rules included.

Limits:
- Codex 0.162 has no switch for `$CODEX_HOME/AGENTS.override.md` or `AGENTS.md`. The first non-empty
  of the two still reaches every Codex call. Cairn's installer appends to `~/.codex/AGENTS.md`.
- Codex keeps offering its own tools:
  - code-mode `exec` with shell commands, run in the read-only sandbox, which may still read files.
    The exception is an allow rule from the system layer (`/etc/codex/rules`), which still bypasses
    the sandbox.
  - web search (`web.run`, cached mode, on by default);
  - image generation, except on the Free plan.
  Web search and image generation are backend calls outside the sandbox and outside Cairn's count.
- With the skills catalog off, a `$<skill>` mention in the input still makes Codex inject that skill's
  SKILL.md, for example `$cairn-handoff` in a transcript being compacted. The calibration probes
  contain no such mention.
- Managed settings stay out of Cairn's reach. Codex's `managed_config.toml` and its requirements
  outrank `-c`; system and cloud-managed `config.toml` do not. Managed Claude Code settings outrank
  `--settings`. Under a `managed-mcp.json` the managed servers start. Their tools are denied,
  but their instructions reach the model.
- The claude.ai connectors and the ChatGPT apps connector exist only with a subscription login, and
  the offline tests could not observe them. Their switches follow the vendor docs and the Codex source.

In the product, bridge mode always passes `--effort high` / `model_reasoning_effort=high`. API mode
sends Anthropic's `output_config.effort` or OpenAI's `reasoning_effort` (Chat Completions) as `high` for
ids that resolve to a pool model of the endpoint's own provider (including dated, prefixed or `-codex`
variants; a Claude id behind an OpenAI-compatible endpoint gets none), and raises the output
budget to 32,000 tokens: on Anthropic `max_tokens` is a hard limit on thinking plus the answer, and
OpenAI advises reserving at least 25,000 tokens. A suspended or unrecognised model keeps its provider
default and the old budget, because it may reject the field. Sampling mode cannot set an effort: MCP
`sampling/createMessage` has no such field (and the 2026-07-28 spec deprecates sampling), so the
client's defaults apply and its budget is unchanged.

Limits. Claude Code clamps `--effort` to a cap: `maxEffortLevel` in user or managed settings, also per
model under `modelSettings` (any plan, any provider; project and local settings are not loaded), or an
Enterprise role cap; for the latter the docs say the clamp is silent with `json` output, and against a
mock API the other caps gave no notice either. Managed settings, including a managed `env`, outrank
`--settings`. Cairn does not override managed settings or caps and cannot see the applied level, so check for a cap below `high` before a live
run. The API adapters do not stream, so a very long generation at `high` can hit fetch's ~300 s header
timeout and fail the handoff; this predates this ADR and is an open point. Until 2026-10-13 the OpenAI
adapter sent the deprecated `max_tokens` for every model, which OpenAI documents as incompatible with
o-series models. It now sends `max_completion_tokens`, which bounds visible output plus reasoning tokens, for
ids in OpenAI's naming (`gpt-<digit>…` and `o<digit>…`, also as a fine-tune `ft:<base>:…`, read after the id
normalization of the model profiles: any case, a provider prefix such as `openai/`, a `[…]` or `@…` suffix),
and keeps `max_tokens` for any other id, the field OpenAI-compatible servers read: other models (Ollama, vLLM,
a gateway serving Claude, open-weight `gpt-oss`, `gpt2` or `gpt-j`) and an endpoint model named otherwise (an
Azure deployment name, for example). An o-series model behind such a name therefore still gets `max_tokens`,
which OpenAI documents as incompatible; name such a deployment after the model id. An OpenAI reasoning model
outside the pool (a suspended GPT-5.x, an o-series model) runs at its provider default effort with the plain budget of at most 8,192 tokens, which now also bounds its reasoning; if
that runs out, the answer is empty (the handoff fails, nothing stored) or truncated (stored, like any truncated
answer). Until 2026-10-12 a bridge-mode handoff also ignored `finishReason` and stored the
text of a claude error result, the partial answer of a failed Codex run or an empty Codex answer as the
brief; every optional mode stored an answer without text; the API adapters read a JSON error body as an
empty brief (a body that was no JSON made the handoff fail) and kept the partial text of a refused
answer. Until 2026-10-13 the claude bridge also stored output that was no JSON (or JSON `null`) with exit 0
raw as the brief; an `error_*` result without `is_error`, an OpenAI `message.refusal` and a blocked Gemini
prompt failed as an answer without text, but text beside them was stored as the brief (a string `result`,
`content` beside the refusal, a candidate beside the block); claude JSON without a result failed as an
answer without text. That is fixed (see "Who writes the brief").

**Reviewers.** All seven pool models review, at exactly `high`, and each brief is scored by the six
others (k = pool − 1); a model never reviews its own brief. Pool entries are normalised to base ids, so
`x@high` cannot slip past the self-review filter, and the single-probe run passes the full pool
explicitly instead of deriving it from the briefs that succeeded. Artifacts keep every review (reviewer,
rubric, fidelity), list only reviewers that actually scored, and record `reviewerEffort`; the golden
output adds verbosity, spread and the spread warning per probe. That allows a bias check: a model
family's mean score from its own family against the mean from the other family.

**Runs and artifacts.** Artifacts are named `<date>T<time>Z-<mode>[-golden|-large].json` and never
overwritten (a taken name gets `-2`, `-3`, …). They keep each scored brief and the ids of the
must-survive items the deterministic check missed (`missingMustSurvive`, the same matching as
`computeRecall`). A paid run can then be checked again without rerunning it. A `provenance` block
records:
- the commit of this code's own checkout, asked in the package root rather than the cwd, with git's
  repository variables (`GIT_DIR` …) removed (null for an installed package, a subfolder of another
  repo or an unborn HEAD);
- whether tracked files differ from it (a gitignored `dist/` does not count);
- the Node version;
- for a real run only, the first non-empty line of `claude --version` and `codex --version`. A dry
  run starts neither CLI.

A CLI that exits before reading its whole prompt no longer crashes the run. Node gets `EPIPE` in two
cases:
- the unread part of the prompt exceeds the stdin buffer, a socket pair of about 128–150 KiB here. With
  the 1.6 MB high-fill probe that holds unless the CLI read nearly all of it.
- the CLI exited before the write.

`defaultExec` records that error and fails the call, even if the CLI exited with 0, because an answer
to a truncated prompt is no answer. The run keeps its artifact.

Limits:
- A CLI that leaves less than the buffer unread and exits with 0 can go unnoticed. claude and codex read
  their whole prompt.
- The product handoff stores nothing from a failed call ("Who writes the brief").

`--dry-run` resolves the live configuration on the fixture
compactor and heuristic reviewer and prints the call count: 49 for the single probe (7 briefs + 42
reviews), 245 for the golden set (35 + 210), 28 for the high-fill probe at
`CAIRN_CALIB_PROBE_TOKENS=400000` (4 Claude briefs + 24 reviews; GPT-6 does not fit Codex's window,
and the 800K default fits no model). Bridge windows:
- Claude Fable 5.1, Sonnet 5.5 and Haiku 5.5 at 1M. This is Claude Code's documented default, not yet
  bridge-measured.
- GPT-6 via Codex at 258,400, the window Codex applies, read from real runs in stage 4b' on
  2026-10-11. All three rollouts report this `model_context_window`, Codex's usable 95 % of the
  catalog's 272,000 in codex 0.162.1. It is a client-side value, not a test of the server limit. In the
  same rollouts `turn_context` names the requested model and effort `high`.
- Codex compacts on its own from 244,800 (90 %) mid-turn whenever it continues a turn: after a tool
  call, after an interrupted response, or on `end_turn: false`. Other incomplete responses end as
  errors. A fresh call starts below every threshold.
- A system or cloud config, which `--ignore-user-config` does not skip, could add post-turn compaction
  or a lower limit. The bridge pins neither.

**Decision basis.** The model decision uses the golden-set mean (5 probes), including its verbosity. The
earlier precedent of keeping the single-probe score for cross-profile comparability (GPT-5.4) is not
needed here, because all seven models are measured in the same runs. The result below pools two runs and
takes each reviewer's leniency out of the scores.

**Calibration result (2026-10-12).** The golden set ran twice on commit `b220756` (06:17 and 07:31 UTC),
each run 245 calls (35 briefs + 210 reviews) without a skip, with claude 2.1.296 and codex-cli 0.162.1.
`npm run calibrate -- --pool <artifacts>` pools them without a model call: 10 probe runs per model, one
reviewer-effect fit over all 420 reviews, and the stored briefs checked again against the current ground
truth. It writes `…-pooled-golden.json` with the inputs' SHA-256, and refuses an artifact given twice (by
file hash, or by its briefs and the reviewers' own scores in any order, so a re-serialized, reordered or
re-scored copy too; an old artifact without briefs and reviews is compared by its whole rows) or runs of
other probes, probe contents, models or reviewer effort. An artifact without `probeInfo` (older than that
field, like both runs here) gets a note (`inputNotes`): its probe contents cannot be compared; the others
are compared with the first one that records them. If the effects cannot be fitted (one
reviewer per brief leaves them unidentifiable), a golden run records why (`reviewerEffectsSkipped`) and
still writes its artifact. Between the runs the model means moved by
up to 0.011, more than half the 0.02 band, so one run cannot settle a model near the band edge.

Reviewer bias:
- Claude reviewers rate both families alike. GPT reviewers are stricter overall and rate GPT briefs about
  0.02 higher than Claude briefs. Per author, Claude briefs get 0.028–0.052 more from their own family.
- In the full matrix no model reviews its own brief, so every brief's mean misses its author's own
  leniency or strictness. Raw, that let Haiku 5.5 and GPT-6 Luna, the strictest reviewers of their
  families, gain 0.0035 and 0.0049 over Opus 5.5 and Astra and land just inside the band (0.0005 and
  0.0007 from the edge).
- The correction (`fitReviewerEffects`): fidelity ≈ brief quality + reviewer effect, fitted by least
  squares, effects centred on 0, then each review minus its reviewer's effect. Pooled effects: Fable 5.1
  +0.0239, Sonnet 5.5 +0.0228, Opus 5.5 +0.0111, Astra −0.0040, Haiku 5.5 −0.0098, GPT-6.1 Sol −0.0106,
  Luna −0.0334. The model does not remove a family preference (GPT reviewers on GPT briefs); that only
  shifts comparisons across ecosystems, which the selection never makes.

| Model | Fidelity (corrected) | Raw mean | Verbosity | Confidence |
|---|---|---|---|---|
| GPT-6 Astra | 0.9639 | 0.9646 | 0.90 | 0.98 |
| Claude Opus 5.5 | 0.9596 | 0.9577 | 1.11 | 0.98 |
| GPT-6.1 Sol | 0.9573 | 0.9590 | 0.88 | 0.98 |
| Claude Fable 5.1 | 0.9510 | 0.9470 | 1.13 | 0.98 |
| GPT-6 Luna | 0.9397 | 0.9453 | 0.76 | 0.98 |
| Claude Haiku 5.5 | 0.9366 | 0.9382 | 1.15 | 0.98 |
| Claude Sonnet 5.5 | 0.9363 | 0.9325 | 1.10 | 0.98 |

Confidence is 1 − spread of the corrected reviews, averaged over the probe runs. Verbosity does not depend
on the reviewer.

Selection with these values:
- Claude hosts get Claude Opus 5.5 in every zone. Fable 5.1 shares the band but costs more; Haiku 5.5
  (0.0230 below Opus) and Sonnet 5.5 (0.0233) are outside.
- Codex hosts get GPT-6.1 Sol in every zone. Astra shares the band but costs more; Luna is 0.0242 below
  Astra.
- A typical handoff (180K input, 6K brief × verbosity) costs about $0.85 with Opus 5.5 and $0.41 with
  GPT-6.1 Sol.
- Haiku 5.5 and Luna are outside the band by only 0.003 and 0.004; in run 2 alone both were inside.

**Band rule (2026-10-12).** The floor is checked over the whole band: the cheapest band model that clears
the zone floor is selected, and the selection falls back to verbatim only when no band model clears it (ADR-0004,
corrected). Before, only the cheapest band model was checked.

**Who writes the brief (2026-10-12).** The selection never chose the writer: in account mode the host
writes the brief, and the optional modes passed the host's own model id to the caller. A first change let
bridge and API compact with the selected summarizer instead; it was reverted before release (user
decision, 2026-10-12). In every mode the session model writes the brief, and the selection is a
recommendation:
- Account mode makes no model call; the host writes the brief.
- Bridge and API ask for the session model (`host.modelId`) where it runs: in the bridge CLI's ecosystem
  (`CAIRN_BRIDGE=claude` takes a Claude id, `codex` a GPT id) or at the API endpoint's provider. An
  endpoint with a configured model always uses it, since a gateway or an Azure deployment names its own
  models. The model id decides the ecosystem when it names one (`claude…`, `gpt…`), so a contradicting
  provider does not send a GPT id to claude; an id that names none (an alias like `opus`) counts by the
  provider.
  - The claude bridge passes Claude Code's context variant (`claude-opus-5-5[1m]`) as `--model`, as Claude
    Code accepts it; the codex bridge drops a bracketed id, since Codex has no such suffix. API mode sends
    the id without that suffix: it is Claude Code's, not part of the API model id.
  - Without a session model of its ecosystem (a Codex host with a claude bridge, or no model id given) the
    bridge passes no model, and the CLI runs its own default. For claude that is the model Claude Code
    picks without `--model`: `ANTHROPIC_MODEL` (also from a settings `env` block), else a managed `model`
    setting, else the user's `model` setting, else an organization default (Enterprise; one set to override
    user selection comes before the user's setting), else `ANTHROPIC_DEFAULT_MODEL`, else the model recorded
    on the account or the account type's default. The bridge loads no project or local settings. For codex
    it is the default without the user's `config.toml`, which the bridge ignores; a system, managed or
    project config can still set one.
  - An API endpoint without its own model and without a session model of its provider makes Cairn refuse
    the call before any egress instead of sending an empty model id.
  - An endpoint outside the pool (gemini) uses its model, else the host's, and gets no effort or effort
    budget.
  - The bridge always runs at effort `high`; API mode sends `high` only to a pool model of the endpoint's
    own provider, and any other model keeps its provider's default.
- Sampling cannot choose the client's model; the session model goes along as `modelPreferences.hints`.
- The selection runs in the ecosystem the brief is written in: the host's, or for bridge and API the
  CLI's or the endpoint provider's. When it names another model than the one that wrote the brief, or that
  model is unknown, the result recommends it (`recommendedModel`). It does not when the model asked for
  (the request, in sampling the hint) already is the selection, since switching the session model would
  change nothing: neither when another model answered as a fallback (the result names that one in
  `compactedWith`) nor when the answer went unreported. Nor for an endpoint outside the pool (gemini), where the
  selection, made in the host's ecosystem, names a model the endpoint does not run. The tool text says how
  to get the recommended model:
  - after the session model: switch it (`/model`) and run Cairn Handoff again. When the writer is
    unknown (in account mode a host that names only its provider, in sampling a client that reports no
    model while the hint is not the selection or there is none), the line says "if the session runs another
    model" instead of claiming one;
  - after an endpoint's configured model: set that endpoint to the recommended model;
  - after the bridge CLI's default: the line names the recommended model only.

  The handoff skill passes that line on and passes the host's own model id.
- A failed or empty compaction stores nothing (user decision, 2026-10-12). `CompactionFailedError`
  (`<mode> compaction …; nothing stored, the previous brief stays current`) is raised for:
  - a call that fails: a CLI or network error, or an API HTTP error, which carries the provider's
    `error.message` or a string `error` (at most 300 characters; the status only when the body has
    neither);
  - a claude error result (`is_error`, an `error_*` subtype also with `is_error: false`, or any claude
    output with a non-zero exit; one without a `result` text is reported with its `errors` messages),
    claude output that is neither a JSON object nor a JSON array (also with exit 0: a wrapper, a changed
    format, `null`, text after the JSON), claude JSON without a result (a result that did not fail without
    a string `result`, an array without a `result` event, `{}`; with exit 0 reported as `claude's JSON
    output has no result`), or a failed Codex run, also one with a partial answer;
  - an answer the provider stopped short of a regular end or the output cap, with or without partial
    text: Anthropic `stop_reason: "refusal"`, OpenAI `finish_reason: "content_filter"` or a
    `message.refusal` (reported with its text), or any Gemini finish reason other than `STOP`,
    `MAX_TOKENS` and the unused `FINISH_REASON_UNSPECIFIED` (`SAFETY`, `RECITATION`, `BLOCKLIST`,
    `PROHIBITED_CONTENT`, `OTHER` …; none given means the model has not stopped); a Gemini prompt
    blocked by a non-empty `promptFeedback.blockReason` other than the unused
    `BLOCK_REASON_UNSPECIFIED` (documented to come without candidates; it wins over one) counts the same
    way and is reported as `prompt blocked: <reason>`;
  - an answer without text (also only whitespace).

  A refusal before the call stays `EgressNotConfiguredError`. No brief, decision or evidence of that
  handoff is written, so the previous brief stays current. A truncated answer (output cap reached) is still
  stored in API and sampling mode; Codex itself turns an incomplete response (any reason but an
  interruption) into a stream error, so the codex bridge returns no cut-off answer. Account mode stores the
  host's brief as given.
- The result names the model that compacted (`compactedWith`), and the ledger credits the brief to it
  (`who`): the model the caller reports as answering (claude's `modelUsage`, a codex reroute, the sampling
  client's `model`) when it is not the requested one, else the requested one. Unknown (the CLI's default
  without a report, a sampling client that names no model) leaves it out; the brief then stays credited to
  the host.
- Why the session model: the user wants the model they work with to write the brief, in every mode, to
  keep cost and context down; the recommendation still names the more faithful model. An opt-in that read
  the session transcript from disk and compacted it again through the host's CLI was also built and
  removed before release: it doubled the model cost and context of every handoff, and its review found a
  stale session id after `/clear`, `/branch` or `/resume`, a foreign Codex rollout without a cwd match,
  Codex's 60 s tool timeout, Codex's encrypted remote compaction, provider settings bypassed, and
  transcript content (tool output, web pages) steering a child with a shell and web search. Switching the
  model by hand gives the same brief with the context the session already holds.

**Fidelity floor 0.84**, signed off by the user on 2026-10-12. Opus 5.5 (0.9596) and GPT-6.1 Sol (0.9573)
clear even the red zone (0.84 + 0.10 = 0.94), by 0.020 and 0.017, so a full context is compacted, not
handed over verbatim. Fitted run by run, they scored 0.9650/0.9541 and 0.9543/0.9603, above 0.94 in both.
- Without Opus 5.5 a Claude host gets Haiku 5.5 in green and yellow and Fable 5.1 in red (Haiku 5.5 and
  Sonnet 5.5 miss 0.94).
- Without GPT-6.1 Sol a Codex host gets Astra in every zone.
- The golden `floorProposal` (median of the means, 0.947 raw and 0.951 corrected, pooled) is not used:
  with the +0.05/+0.10 zone bumps it would send every yellow and red handoff to verbatim.

**What the briefs kept.** Before the model call Cairn masks code fences, inline code and flagged exact values
behind `[[CAIRN-HOLD-n]]` markers and restores them byte-exact afterwards (`freezeVerbatim`, the same path
as the product handoff). All seven models kept every marker in all 70 briefs, so all 22 exact must-survive
items (code, configs, error strings, identifiers) came back byte-exact (hard verbatim score 1.0). The
reviewers rated recall 0.966–0.998; the main deduction is the hallucination criterion (0.807–0.893).

The deterministic must-survive check now matches every non-exact item by its key facts (`keys`: AND over
groups, any alternative per group; words and numbers end where the key ends, so "400" does not match
"400k" or "4000" and a key lists the unit forms it accepts ("1.8s"); a word before `://` is a URL scheme,
not the word; a decimal comma reads as a point; a `*` lifts the boundary only at the edge of a key)
instead of the whole ground-truth sentence, which a paraphrase never repeats. The keys cover German and
English forms and unit spellings, and a test holds 133 paraphrases and look-alikes from three review
rounds to their expected result. The check stays a bag of keys: it ignores
negation and distance between groups, so some look-alikes still pass (ADR follow-up below). Every item's own text carries
its keys, and a brief of bare bucket headings carries none. Rechecked without a model call, every model
keeps all 69 key facts in all 70 golden briefs and all 20 in the four high-fill briefs. Five of them (the
batch size, the refresh-token TTL, the key rotation, the replicas, the disruption budget) appear only
inside the verbatim blocks the model kept, in every brief of every model; 19 of the 89 items can be met
by restored verbatim blocks alone. The deterministic check therefore finds no difference between the
models on these probes; the reviewers' recall (0.966–0.998) and hallucination scores do.

**High-fill control (4d, 2026-10-12).** At `CAIRN_CALIB_PROBE_TOKENS=400000` (1.6 MB probe, 28 calls), the
four Claude models were measured; GPT-6 does not fit Codex's window.
- The probe holds its scored facts in three small blocks: at the start, in the middle (about 50 %) and at
  the very end; the rest is padding. Every brief kept facts from all three blocks and every verbatim
  marker. Fable 5.1, Opus 5.5 and Sonnet 5.5 also named the padding ranges correctly, Haiku 5.5 did not.
- Fidelity with all reviewers (not corrected): Opus 5.5 0.9295, Sonnet 5.5 0.9250, Fable 5.1 0.9165,
  Haiku 5.5 0.9165. With the three foreign reviewers only: 0.86–0.90.
- That is lower than the golden values. It is one probe with six reviews per brief, a control
  measurement, and does not feed the profiles.

Limits:
- The golden probes are 0.3–1.3K tokens; behaviour at large inputs (Haiku 5.5's tier above 100K) is
  covered only by the single 4d probe.
- Verbosity counts the raw model output's characters / 4 (with the verbatim markers, before the restore),
  not the reasoning tokens that `high` adds to the bill.
- Artifacts now record each probe's length and SHA-256 (`probeInfo`, with the token target for the
  high-fill probe) and the candidates pre-excluded by window (`preExcluded`); the 2026-10-12 artifacts
  predate that.
- The profiles were measured with the compaction prompt before 2.0.0. ADR-0013 changes the prompt, and
  artifacts record its hash (`promptSha256`) from then on.

**Codex alternative.** `host_status` now suggests GPT-6.1 Sol for Codex. ADR-0011 names GPT-6 Sol: that is
Codex's direct replacement for the retiring GPT-5.5 on Plus, Pro, Business, Enterprise and Edu plans.
GPT-6.1 Sol is the model the Codex models page recommends (`codex exec -m gpt-6.1-sol`). Both statements
hold.

**Follow-up.** Live calibration in stages, each only after explicit approval, all done:
- 4b single probe (2026-10-11, 49 calls, no skips);
- 4b' measurement of the GPT-6 Codex window (2026-10-11);
- 4c golden set (2026-10-12, two runs of 245 calls, pooled);
- 4d high-fill at 400K (2026-10-12, 28 calls, control only).

The measured values are in the profiles, the floor in `FIDELITY_FLOOR`. Done on 2026-10-12: the band rule,
the reviewer-effect correction and the key-fact check (above). Open points:
- A third run or more probes would settle Haiku 5.5 and GPT-6 Luna, 0.003 and 0.004 outside the band.
- On the golden probes every model keeps every key fact; harder or longer probes, with more facts in
  prose than in verbatim blocks, would show differences in what the models keep.
- The key check is a bag of keys: a negated mention ("evaluated Postgres but stayed on SQLite"), a
  mention inside an identifier (`POSTGRES_PASSWORD`), groups far apart ("HTTP 400 … 290 €"), a unit after
  a space ("16 GB") or an alternative met in another context ("the HPA keeps at least 5 pods", "no
  American Express") can still meet an item, and some paraphrases (number words, "U.S.", "replicaCount:
  6", "every quarter") still miss it. Three review rounds showed that widening the keys adds look-alikes
  and narrowing them loses paraphrases; matching within one sentence would be the next step. The
  reviewers judge these cases, and the profiles do not depend on the check. Decided on 2026-10-12: the
  check stays as it is. Sentence matching pays off only together with the harder probes above, which need
  a new paid calibration run.

---

## ADR-0013 — Grounded briefs: quotes for what was said, (derived) for inference (2026-10-13)

Accepted. Extends ADR-0006 (the modes that compact with the 7-bucket prompt) and ADR-0007 (continuing from
the brief). Resume keeps treating the ledger as data, not instructions (CHANGELOG 2.0.0, "Resume: ledger is
data, not instructions").

**Context.** In the real end-to-end test on 2026-10-13, Claude Opus 5.5 at `high` wrote a brief whose facts
were all right, but three lines read like the user's decisions and were the model's inference:
- a constraint nobody set ("Option (b) must not touch the worker protocol in this change");
- a measured value as a target ("Target: 0 lost writes under 8 concurrent workers");
- an option the user deferred, listed as discarded with a reason the model inferred.

The calibration shows the same pattern: hallucination is every model's weakest criterion (0.807–0.893,
ADR-0012), while recall and verbatim are close to 1. The prompt said "Invent nothing" and had no rule for an
empty bucket, a measured value or a deferred option. Its wording dates from 1.4.0. With it the models almost
never quoted: 5 quotes in 72 real briefs (the 70 golden briefs of 2026-10-12 and the two end-to-end
briefs). The next session could not tell what the user said from what the summarizer concluded.

A prompt rule lowers the rate of such lines; it cannot rule them out, and the risk is that the next session
acts on them. So the brief marks which is which, and Cairn checks it where it has the source.

**Decision.**
- **Prompt** (English and German; used by sampling, bridge, API and the calibration):
  - every bucket appears, an empty one says none;
  - double quotes go only around exact words from the context, in one piece without omissions, and a
    decision or constraint a person set is given that way, in their own words;
  - CONSTRAINTS holds only what the context sets, and a measured value is not a target (it is EVIDENCE);
  - DISCARDED holds only options the context rejects, with the reason it gives; a deferred option is not
    discarded, OPEN QUESTIONS holds it;
  - NEXT STEPS holds steps the context names or agrees on;
  - a constraint, target, reason or step the context does not state is the model's own inference, and it
    marks that item by appending `(derived)`. The marker is the same in both languages, like the bucket names.
- **Handoff skill** (account mode, the default): these rules for the host that writes the brief, with "the
  user or another person" for the person.
- **Resume** (skill, Codex AGENTS block, MCP server instructions):
  - double quotes mark exact words from the conversation;
  - `(derived)` and a closing Cairn check note mark the summarizer's inference;
  - before an unquoted or derived constraint stops or redirects the next step, the session checks it against
    the code or asks the user.
- **Quote check** (sampling, bridge, API; `src/core/grounding.ts`): after the restore, each quote in the brief
  must appear in the source as given (not its masked form).
  - What counts as a quote: double quotes on one line (`"…"`, `“…”`, `„…“`, `«…»`, `»…«`) with at least
    three words. Fenced code (```` ``` ```` and `~~~`) is left out and ends a line; inline code counts as its
    text, so a quote may contain it. A straight `"` opens after a non-word character and before a non-space,
    and closes after a non-space and before a non-word character, so a mark inside a word opens or closes
    nothing. A quote inside a quote is read as well as the outer one.
  - Both texts are normalized: apostrophes folded, NFKC, lower case, ß as ss, no `>` quote markers at line
    starts, a Markdown link as its text, dashes as a hyphen, no double quote marks, `*`, `_`, `~`, `` ` ``,
    soft hyphens or zero-width characters, one space per whitespace run.
  - The quote, without the punctuation at its edges, must occur in one piece at word boundaries ("safe" is not
    in "unsafe"), and not right after a negation word (English or German: "do not" + "switch to Postgres").
    An omission (`…`, `[…]`) is not word for word.
  - A quote that a Cairn check note in the source already lists stays unverified, so a resumed brief in the
    conversation cannot clear its own note on the next handoff. A note is read to the end of its line; in
    escaped text (a JSON string) to a literal `\n`, and the rest of such a line is flagged too.
  - A quote the source lacks is listed in `unverifiedQuotes` and in a warning line of the tool text. The
    stored brief gets a closing note: `[Cairn check] Not found word for word in the source, so treat as
    derived: "…"`, or the German `[Cairn-Prüfung]`.
  - `missingRequired` is judged before the note is added, so the note's copy of a quote never counts as a
    kept span.
  - Account mode has no source: there is no check and no field.
- **Calibration**:
  - golden and single-probe artifacts record `promptSha256`, the SHA-256 of the compaction system prompt as
    the CLI receives it: the 7-bucket prompt plus the brief-only directive (`compactionPromptSha256`). Dry and
    offline runs record the prompt they are configured with, though the fixture compactor sends none; a
    pooled artifact carries its inputs' hash when they have one;
  - `--pool` refuses inputs whose hashes differ. An artifact without one predates this ADR and ran the prompt
    before 2.0.0, so it pools only with others without one;
  - a test pins the hash, so a prompt change is a conscious step.
  - The reviewer rubric and the probes are unchanged, so scores before and after compare.

**Measured before the change** (no model call): over the 72 real briefs above, the quote check finds 5
quotes, all in the source, and no `(derived)` marker.

**Limits.**
- Account mode checks nothing: the session model writes the brief from its own context, and Cairn sees only
  the brief.
- The check finds the words, not who said them or in which sense: a sentence the assistant proposed and the
  user rejected is in the source too, and a quote may leave out words around it ("in this sprint") other
  than a negation right before it.
- The unverified quote keeps its quote marks in the brief; only the closing note marks it as derived.
- A paraphrase without quotes is not checked.
- Numbers and identifiers are not checked. A check would raise false alarms on converted values and dates,
  and it would not have caught the observed lines: both numbers in the "Target" line are in the source.
- Quotes of fewer than three words and quotes over a line break are not read; a German quote with an English
  quote inside („… “…” …“) is not read at all. A translated quote counts as not found.
- The reviewers see the ground truth, not the source, so they may score a correct `(derived)` line as
  invented.
- The profiles (ADR-0012) were measured with the prompt before 2.0.0.
