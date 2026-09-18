# DECISIONS

Records the R6/R7 landing decisions when research lands (ws-j acceptance: "R6/R7 landing checklist stubs present"). Nothing here is decided yet.

## R6 — fixture corpora (adopt/adapt/roll per role)

**Status: pending — see STATUS ("Blockers for the human").** R6 has not landed. Micro-suites landing in phase 3 (J3) are hand-seeded regardless of R6's verdict.

## R7 — runner framework (evalite/promptfoo/Inspect vs thin-custom)

**Status: pending — see STATUS ("Blockers for the human").** The thin-custom runner (`runner/`, phase-2 goal J2) is the null hypothesis and is built regardless of R7's verdict; R7 decides whether a framework replaces or wraps it.

## Contamination posture (in force now)

Provenance is marked per suite (`schema/suite.schema.json` `provenance.origin` / `provenance.reference`). Generated or mutated faults are preferred over verbatim public benchmark instances (R6 brief), so scores measure fixing and classification skill rather than benchmark recall.

## Micro-suite reference fixes (eval validity)

The reference fixes that prove the micro judges discriminate live in `test/micro.test.ts` (the `SOLUTIONS` map) — inside the shipped tree. A real fixer worker that could read them would be answering by lookup, not by fault diagnosis, corrupting eval scores (cq-fixtures review-debt issue [#11](https://github.com/camerontaylor/cq-fixtures/issues/11), deferred from PR #10).

J5 disposition — both halves recorded here:

1. **Eval-time excision (implemented).** The model-driven `matrix` job of `.github/workflows/suite.yml` removes `test/` from its checkout after `npm ci` and before any model-facing step, in every cell. Read/edit tools were already confined to the materialized workspace; the excision closes the remaining in-checkout path (a host-privileged run tool reading the checkout). The unit tests themselves still run in the repo's static CI jobs — only the model-facing job excises them.
2. **Accepted-risk re-confirmation (recorded).** The honestly-unreachable residual: a worker with a widened run allowlist and network egress could fetch the public repo's copy of the file. The first-party-prompt accepted-risk class (recorded in `.github/workflows/suite.yml`'s credential note) is explicitly re-confirmed here to cover answer-lookup risk for the micro suites: suite prompts are first-party, provenance-marked fixtures, and the row-level honesty rules (observed model, journaled attempts) keep a lookup-inflated score auditable after the fact.

The phase-3 alternatives stay rejected for the reasons recorded on issue #11: CI-secret injection makes the repo's own discrimination tests conditional on a secret (weaker acceptance evidence), and generating answers from transform recipes is the answer in compressed form — equally findable.
