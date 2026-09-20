Labeled review-thread suites for the review-classifier role: each case = {thread payload, expected verdict} in WS-E's verdict vocabulary (plan §3.2; ws-j item 3).

`micro/` is the populated suite (phase-3 J3, 2026-09-16): ten fictional, recorded-SHAPE thread
payloads (`fixtures/threads/thread-{01..10}.json`), two per expected verdict — actionable,
responded, resolved, blocked, skip — with the payload-to-verdict table in `micro/PROVENANCE.md`.
The classifier's structured output must be `{"verdict": <one of the five>}`; scoring is a
verdict match. The judge contract and the fake-smoke `--driver-name subprocess` labeling
decision are recorded in `suites/README.md`.

## Breadth suites (F4, 2026-09-21)

N=60 total: `breadth-verified/` (30, two annotators + adjudication) + `breadth-tail/`
(30, LM-draft + one annotator + 20% double-coded audit). Balance is 12 per verdict — a
design target, not a field prior (recorded in each suite's `provenance.origin`). At least
20 of 60 are suspicious-but-benign (expected non-actionable) so the FP rate is scoreable;
at least 6 carry adversarial-reply patterns.

Difficulty calibration: `micro/` is near-saturated (7-9/10 at n=10 for flash-class
models); breadth adds hard negatives with the declared target of frontier accuracy
0.55-0.80 at N=60. Report macro-F1 alongside accuracy (the tables carry `byVerdict`,
`macroF1`, and `fpRate` — see `schema/comparison-table.schema.json`).

Labels live in `LABEL-GUIDE.md` (rule chain R0-R6, version 1.0) with a `label.json`
adjudication record beside every payload. Verified-tier agreement target is Cohen's
kappa >= 0.75; tail audit >= 0.70. Agreement numbers are recorded in the label files
and PROVENANCE tables once the second pass lands — pending until then, never estimated.
