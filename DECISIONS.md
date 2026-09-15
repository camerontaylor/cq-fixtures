# DECISIONS

Records the R6/R7 landing decisions when research lands (ws-j acceptance: "R6/R7 landing checklist stubs present"). Nothing here is decided yet.

## R6 — fixture corpora (adopt/adapt/roll per role)

**Status: pending.** R6 has not landed. Micro-suites landing in phase 3 (J3) are hand-seeded regardless of R6's verdict.

## R7 — runner framework (evalite/promptfoo/Inspect vs thin-custom)

**Status: pending.** The thin-custom runner (`runner/`, phase-2 goal J2) is the null hypothesis and is built regardless of R7's verdict; R7 decides whether a framework replaces or wraps it.

## Contamination posture (in force now)

Provenance is marked per suite (`schema/suite.schema.json` `provenance.origin` / `provenance.reference`). Generated or mutated faults are preferred over verbatim public benchmark instances (R6 brief), so scores measure fixing and classification skill rather than benchmark recall.
