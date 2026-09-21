# DECISIONS

Records the R6/R7 landing decisions (ws-j acceptance: "R6/R7 landing checklist stubs present"). R6 and R7 are **decided and owner-ratified** (rows below); both landed 2026-09-21.

## R6 — fixture corpora (adopt/adapt/roll per role)

**Status: decided — ADAPT (fixer) / ROLL (review-classifier).** Owner ordered implementation 2026-09-21 (plan APPROVED; overseer dispatch plans/delegation/fixtures-build-STATUS.md).

> **R6 — fixture corpora: ADAPT (fixer) / ROLL (review-classifier).** `fixer-worker` adopts the SWE-smith
> generation strategies + execution-validation filter and the SWE-smith/StrykerJS operator catalog, ported
> to a TS-native engine (StrykerJS instrumenter, Apache-2.0; ts-morph, MIT), and rolls synthetic multi-module
> TS fixtures. `review-classifier` rolls adjudicated thread payloads (no public corpus carries the 5-verdict
> thread-state label), adapting the Gunawardena 15-group routing taxonomy + Turzo & Bosu `False Positive`
> flag. First breadth suites: `fixer-worker/breadth-verified` (12) + `breadth-tail` (28); `review-classifier/
> breadth-verified` (30) + `breadth-tail` (30, ≥20 suspicious-but-benign). Per-fault metadata lives in a
> fixture-side `FAULT.json` (the suite schema is closed). No public benchmark instances are vendored;
> per-suite `provenance.origin` = generated/mutated.

Sources: `research/research-20260921-fixtures-buildout/r6-sourcing-digest.md` §9 (paste-ready row above, verbatim) + full digest §§1–8; evidence base `reports/prior-art-survey-2026-09-16.md` §8. Executed as plan §5 goals F2–F4.

## R7 — runner framework (evalite/promptfoo/Inspect vs thin-custom)

**Status: decided — KEEP the thin-custom runner.** Owner ordered implementation 2026-09-21 (plan APPROVED; overseer dispatch plans/delegation/fixtures-build-STATUS.md).

Deciding factors (from the digest §"Recommendation", in order): (1) the null hypothesis already passed its live test — the 2026-09-18 five-cell matrix ran the full pipeline including the honesty paths; R7 gates ergonomics, not existence, and no ergonomics pain is on record; (2) the runner **is** the package-boundary integration test (req. 6) — wrap options either add ~zero around `runSuite` as a library or bypass the boundary test; (3) DD-4 two-probe scoring, cwd=workspace re-run, observed-model rule, no-fabricated-row budget gating, exit-code discipline (reqs. 2+7) are bespoke and already encoded — every candidate needs glue equal in size to what exists; (4) the broken lanes are lane/infrastructure defects, not runner defects; (5) cost of keep is lowest (~1.5k lines, zero extra deps, Node-only CI).

**Wrap-later carve-out (recorded, not built):** if suite count grows (R6 scale) and serial `runSuite` strains the weekly window (parallelism), or authors want progress UI, run caching, or cross-run dashboards / a trace viewer, re-evaluate a *reporter-only* wrap — a framework reads `rows.jsonl` and owns no dispatch/scoring.

**Re-open triggers (verbatim from the digest):** (1) evalite or a 2026 TS-first entrant ships an agentic task + custom-schema-native + indeterminate-state story — re-run this comparison; (2) suite count × matrix cells makes serial `runSuite` too slow for the weekly window (parallelism is the trigger, not fashion); (3) the toolkit's own seam changes (new driver lane, governor semantics) in ways a framework would absorb for free; (4) any candidate gets a verified TS-native cq-toolkit-equivalent driver seam.

**Freshness caveat + closure:** the R7 lane had no web access, so it marked all framework license/pulse claims UNVERIFIED; the orchestrator verified licenses 2026-09-21 via npm/GitHub APIs — evalite MIT, promptfoo 0.123.1 MIT, Inspect AI **MIT** (pushed 2026-09-19 — the digest's Apache-2.0 recollection was wrong), Harbor Apache-2.0. All candidates are license-compatible and maintained, which *confirms* the verdict rested on structure, not freshness: reqs. 2/6/7 are the blockers, not vendor state.

**Runner hardening backlog (keep-option work, not framework work):** ai-sdk fixer driver-error triage (real spend, zero probes — the highest-value unknown in the 2026-09-18 snapshot); subprocess headless CLI config; claude-agent peer CI failure; acp installable backend + spend-capped eval key (owner actions). If any of these turns out to be a *runner* defect rather than a lane defect, re-open R7 with that evidence attached. Runner risks of keeping: bespoke code with one maintainer; vitest-runner ergonomics (parallelism, caching, dashboards) must be hand-built as suites scale; drift risk between mirrored vocabularies (runner VERDICTS vs suite schema enum).

**No framework migration PR — explicitly out of scope.**

Sources: `research/research-20260921-fixtures-buildout/r7-runner-digest.md` (verdict, deciding factors, carve-out faithful to digest; triggers verbatim); license/pulse verification recorded in `plans/cq-fixtures-build-plan.md` §4 WB-4 and §9.

## Contamination posture (in force now)

Provenance is marked per suite (`schema/suite.schema.json` `provenance.origin` / `provenance.reference`). Generated or mutated faults are preferred over verbatim public benchmark instances (R6 brief), so scores measure fixing and classification skill rather than benchmark recall.

## Micro-suite reference fixes (eval validity)

The reference fixes that prove the micro judges discriminate live in `test/micro.test.ts` (the `SOLUTIONS` map) — inside the shipped tree. A real fixer worker that could read them would be answering by lookup, not by fault diagnosis, corrupting eval scores (cq-fixtures review-debt issue [#11](https://github.com/camerontaylor/cq-fixtures/issues/11), deferred from PR #10).

J5 disposition — both halves recorded here:

1. **Eval-time excision (implemented).** The model-driven `matrix` job of `.github/workflows/suite.yml` removes `test/` AND `.git` from its checkout after `npm ci` and before any model-facing step, in every cell. Read/edit tools were already confined to the materialized workspace; the excision closes the remaining in-checkout paths — the working-tree copy and the shallow clone's object store (the HEAD tree's blobs stay recoverable via `git show` until `.git` is removed). The unit tests themselves still run in the repo's static CI jobs — only the model-facing job excises them.
2. **Accepted-risk re-confirmation (recorded).** The honestly-unreachable residual: a worker with a widened run allowlist and network egress could fetch the public repo's copy of the file. The first-party-prompt accepted-risk class (recorded in `.github/workflows/suite.yml`'s credential note) is explicitly re-confirmed here to cover answer-lookup risk for the micro suites: suite prompts are first-party, provenance-marked fixtures, and the row-level honesty rules (observed model, journaled attempts) keep a lookup-inflated score auditable after the fact.

The phase-3 alternatives stay rejected for the reasons recorded on issue #11: CI-secret injection makes the repo's own discrimination tests conditional on a secret (weaker acceptance evidence), and generating answers from transform recipes is the answer in compressed form — equally findable.
