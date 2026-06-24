# Calibration Spec (for Ticket T3)

Makes ADR-0005 concrete. Goal: a measured `fidelityScore` (0..1) and `verbosityCoeff` (relative to the median) per model, reproducible on every new model / price update.

> The concrete fixtures already live under `docs/calibration/`: `probe-context.md` (the fixed input) and `ground-truth.json` (the scoring key, 28 must_survive / 9 must_not_appear). This file describes the procedure; the fixtures are the data.

## 1. Probe Context

A **fixed example chat, identical for all models**, stored as a fixture in the repo. It must contain exactly the things a brief tends to fail on — otherwise the calibration measures nothing relevant:

- **Multiple superseded decisions** — e.g. "Postgres first, then switched to SQLite, reason X" → tests supersession correctness.
- **Mandatory verbatim blocks** — code snippets, IDs, exact numeric values, a URL, an error string → tests that `freezeVerbatim` takes effect and nothing gets paraphrased.
- **Primacy trap** — a piece of information very early in the context that is still decisive much later for the current state → tests weighting against lost-in-the-middle.
- **Noise** — tool output, abandoned dead ends, banter → tests that irrelevant material is correctly condensed/discarded.

Length: large enough that the tested models cannot trivially retain everything (target utilization in the yellow zone of the smallest candidate's window).

## 2. Ground-Truth Key

A curated list alongside the probe context — the facts/decisions/evidence that **must survive** in the brief. Without it, "fidelity" cannot be measured.

```jsonc
{
  "must_survive": [
    { "id": "d1", "kind": "decision",  "text": "SQLite statt Postgres", "superseded": false },
    { "id": "d0", "kind": "decision",  "text": "Postgres (initial)",     "superseded": true, "superseded_by": "d1" },
    { "id": "v1", "kind": "verbatim",  "text": "API_KEY_SCOPE=read:logs", "exact": true },
    { "id": "e1", "kind": "evidence",  "text": "Bug in zone calc bei surfaceCap=200000", "source_ref": "msg#42" },
    { "id": "p1", "kind": "primacy",   "text": "Zielmetrik = cost-per-task, nicht per-token", "from_turn": 1 }
  ],
  "must_not_appear": [ "erfundene Versionsnummern", "halluzinierte Endpunkte" ]
}
```

## 3. Condensation Run

Every reachable candidate condenses the same probe context with the same 7-bucket prompt and the same `freezeVerbatim` path. Per brief, the runner records: brief text, output token count, chosen model, runtime.

- `verbosityCoeff[m] = output_tokens[m] / median(output_tokens over all m)` — objective, no review.

## 4. Peer-Review Rubric

Each brief is rated by **≥2 of the strongest available third-party models**. **No self-review.** Cross-ecosystem is allowed here (offline). Rating is strict against the rubric, each 0..1:

| Criterion | Question | Source |
|---|---|---|
| Recall | How many `must_survive` items are substantively present in the brief? | Ground-Truth |
| Hallucination | Does anything from `must_not_appear`, or otherwise invented, appear? (inverted) | Ground-Truth |
| Supersession | Are superseded decisions correctly marked as obsolete rather than current? | Ground-Truth |
| Verbatim | Are `exact` blocks byte-accurate? | String comparison, no model needed |

`fidelityScore[m] = weighted mean of the criteria, averaged over the reviewers.`
Weight recall and hallucination higher (those are the expensive errors). Verbatim is checked strictly by string comparison, not estimated by the reviewer.

## 5. Aggregation & Writing

- Average over reviewers; **record the spread (std. dev.) as `confidence`**. High spread → warning instead of silent acceptance.
- Write `fidelityScore`, `verbosityCoeff`, `calibrated: true`, `date` into the profile.
- **Floor proposal:** derive it from the distribution (e.g. floor = the lowest score that still held all `must_survive` items in the probe review). Confirm finally by hand.

## 6. Bias Mitigation

- ≥2 reviewers, mixed across ecosystems where possible.
- Reviewers receive brief + ground-truth, but **not** the author's model name (blind).
- Re-run on every new model / price update; old scores remain versioned and preserved.
