# Calibration Fixtures

The **fixed test basis, identical for every model**, for the calibration run (ADR-0005, Ticket T3).
Spec/rubric: `../calibration-spec.md`.

- **`probe-context.md`** — the immutable input. Condensed with the standard 7-bucket prompt.
- **`ground-truth.json`** — the scoring key: `must_survive` (28 items), `must_not_appear` (9 traps), bucket expectations, weights.

## Procedure per Model (same basis)

1. Give `probe-context.md` **unchanged** to the candidate, same 7-bucket prompt, same `freezeVerbatim` path.
2. `verbosityCoeff` = output tokens of the brief / median over all candidates (objective).
3. Score the brief against `ground-truth.json`:
   - **verbatim** items (`exact: true`): hard string comparison, pass/fail — no reviewer.
   - **recall / supersession / hallucination**: blind peer-review (≥2 strongest available third-party models, no self-review).
4. `fidelityScore` = weighted mean (`scoring.weights`), averaged over reviewers; spread as `confidence`.

## Covered Test Cases

| Dimension | Where in the probe context | Ground-Truth |
|---|---|---|
| Primacy (early binding requirement) | T01 EU/GDPR | `c_eu` |
| Contradiction resolution | T10 → T10b (500 → 400) | `c_budget`, `h_budget_500` |
| Supersession chain | T02→T05 (DB), T06→T08 (OCR) | `d_db_*`, `d_ocr_*` |
| Cross-reference | T07 (AcmeOCR dropped *because of* T01) | `d_ocr_acme` + `c_eu` |
| Verbatim (code/config/error/hash/URL) | T09, T13, T14, T16 | `v_*` |
| Numeric precision | T13, T16, T18 | `n_*` |
| Buried / middle of the context | T08 umlaut, T17 UTC | `cc_umlaut`, `cc_tz` (`buried:true`) |
| Recency (latest request) | T21 | `r_next` |
| Open decisions | T19, T20 | `o_threshold`, `o_worker` |
| Discarded attempts | T02, T06, T08, T12 | Status `superseded`/`discarded` |
| Noise (must be dropped) | T04, T15 | not in ground-truth → must not dominate the brief |
| Mixed language (DE + EN terms) | throughout | fidelity of the technical terms |
| Anti-hallucination | — | `must_not_appear` (9) |
| 7-bucket structure | all turns | `bucket_expectations` |

## Length Scaling (Zone Test)

For the degradation/zone tests (ADR-0003), the probe context may be padded to target token levels
(e.g. by inserting additional realistic turns/noise), **but the scored items stay
unchanged** — otherwise "same basis" is violated. Recommendation: only insert padding between T15 and T16,
and do NOT shift the `[Tnn]` anchors of the ground-truth items (number new turns as `T15a`,
`T15b`, …).
