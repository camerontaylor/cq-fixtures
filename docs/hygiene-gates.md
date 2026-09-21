# Fixture hygiene gates (plan WB-6, F7)

The scored corpus is only as trustworthy as the rules that keep it clean. This
file is the single policy document for the five gates that guard it:

1. the test-adequacy + both-states gate (a case is only a case if its suite
   detects the bug class),
2. deprecate-don't-renumber (retire by moving, never by editing ids),
3. the flake quarantine protocol (a flipping case leaves the scored corpus),
4. no real-repo content without a license row,
5. contamination canaries plus the asymmetry alarm.

Each gate states the concrete procedure, the exact repository path that
enforces it, and the command that reproduces it. Where a rule is enforced by
CI, the workflow file is named; nothing here is a convention that only lives in
a reviewer's head.

## 1. Test-adequacy + both-states gate

**What CI enforces.** Every non-deprecated fixer case must prove six things
about its fixture, in the same static job that runs the unit tests:

| proof | expectation | failure detail the gate emits |
| --- | --- | --- |
| buggy state is red | the stored faulted fixture fails the case's judge (exit 1) | `faulted run N was green` |
| declared F2P titles | every `validation.f2p` title fails in the faulted state | `not failing: …` |
| declared P2P titles | every `validation.p2p` title passes in the faulted state | `not passing: …` |
| canonical fix is green | applying `validation.fix` makes the judge exit 0 | `fixed run N was red` |
| every declared title passes in the fixed state | `p2p-fixed` per-title check | `not passing: …` |
| **the fix is load-bearing** | deleting the recorded `adequacy.delete` statement from the fixed source goes RED again | `deletion stayed green` |

The last row is the adequacy gate, and it is the reason a suite cannot be
seeded by accident: a fixture whose suite stays green with the fixed statement
deleted never described the bug class, so a model that does nothing (or breaks
something else) would score the same as a model that fixes it. Such a case is
inadequate and the pipeline reports `adequacy: deletion stayed green` — the
case never enters the corpus.

**Where.** One runnable filter chain, five enforcement layers:

- `catalog/pipeline.ts` — `runCasePipeline(fixtureRef, { full })` is the chain.
  Gate order in `full: false` (both-states) mode is
  `annotation, reachability, f2p, f2p-per-test, p2p-per-test, baseline,
  p2p-fixed, adequacy`;
  `full: true` adds determinism ×3 and the format/tell pass. The adequacy gate
  sits immediately after `p2p-fixed` and runs in BOTH modes (it writes the
  crippled fixed source into the materialized workspace copy and expects the
  judge to fail). The pipeline never edits a fixture on disk: `validation.fix`
  is applied to a `mkdtemp` copy.
- `catalog/gate.ts` — the CLI. `node --experimental-strip-types
  catalog/gate.ts --check` runs the static evidence inventory only (no judge
  spawn) and exits 1 on any issue; `node --experimental-strip-types
  catalog/gate.ts --all` runs the full executing chain for every record-backed
  case, prints `PASS`/`FAIL` per case with the failing gate details, and exits 1
  on any issue or failure. `catalog/corpus.ts` owns both bodies
  (`checkCorpusEvidence`, `runCorpusGate`).
- `.github/workflows/ci.yml` — the `static` job runs the step
  `Fixture gate — both-states + adequacy evidence (every case)`
  (`node --experimental-strip-types catalog/gate.ts --check`) immediately after
  `Unit tests`. That step is the cheap inventory; the EXECUTING proof rides the
  same job through `npm test` (`test/breadth.test.ts` is discovery-driven over
  every record-backed case).
- `test/breadth.test.ts` — the discovery-driven describe
  `both-states + adequacy CI for every discovered record-backed fixer case (F7)`
  calls `discoverFixerCases(REPO_ROOT).filter((c) => c.recordBacked)` and runs
  `runCasePipeline` once per case (`full: true` for the `-verified` tier). A
  newly seeded record-backed case is therefore gated the moment it is committed
  — there is no list to update.
- `test/hygiene.test.ts` — the static gate at test grain: zero issues from
  `checkCorpusEvidence(REPO_ROOT)`, exactly-once record references, the CI step
  presence check, and the micro grandfather set.

**Static inventory rules (`catalog/corpus.ts`).** For every discovered
record-backed case: the `FAULT.json` must parse, `validation.f2p` and
`validation.p2p` each list at least one title, `validation.fix` must be
non-empty and every fix target must exist in the fixture and DIFFER from the
stored (faulted) content, `adequacy` must be present with `adequacy.file` a key
of `validation.fix` and `adequacy.delete` occurring EXACTLY ONCE in the fixed
source, every declared title must exist in the fixture, and titles must be
unique. Every `fixtures/*.FAULT.json` must be referenced by exactly one
discovered case (`orphan record …` / `record … referenced by N cases`), and
every `fixtures/<id>/check.mjs` fixture directory must be referenced by a
discovered case (`orphan fixture <id>`). The schema keeps `adequacy` optional
for backward compatibility; the gate does not treat it as optional.

**How to add a case.** Author the fixture under `fixtures/<name>/` (with its
`check.mjs` judge), write the sibling `fixtures/<name>.FAULT.json` record per
`schema/fault.schema.json` — including `validation.fix` (the canonical fixed
content) and `adequacy: { file, delete }` — add the case to a suite's
`suite.json` with a never-reused id, then run `node --experimental-strip-types
catalog/gate.ts --check` (inventory) and `node --experimental-strip-types
catalog/gate.ts --all` (executing proof). Both must be green before the record
is committed. The static inventory cannot prove the suite is adequate; only the
executing adequacy gate can, which is why `--all` and the CI test run matter.

**The grandfathered record-less micro set.** `suites/fixer-worker/micro` holds
five hand-seeded synthetic cases, `micro-1..micro-5` (phase-3 J3, 2026-09-16).
They predate the FAULT.json record channel: their fault manifests live in
`suites/fixer-worker/micro/PROVENANCE.md` and their fixed reference
implementations live only in this repo's own harness (`test/micro.test.ts`),
deliberately not shipped as readable repo files. `catalog/corpus.ts` grandfathers
exactly that one suite (`GRANDFATHERED_MICRO_SUITE = 'suites/fixer-worker/micro'`,
`catalog/corpus.ts` line 17): a record-less case there is not an issue, and a
`fixtures/micro-N/check.mjs` directory there is not an orphan fixture. Every
other record-less case fails with

```text
case <suite>/<id>: no fixtures/<name>.FAULT.json record — every new seeded fixture must carry one
```

so the grandfather set can never grow. `test/hygiene.test.ts` pins the legacy
list to exactly `fixtures/micro-1..5` in `suites/fixer-worker/micro`.

## 2. Deprecate, don't renumber

The rule is **deprecate-don't-renumber**. A case id is the join key between
three artifacts: the suite case, the sibling
`fixtures/<name>.FAULT.json` record, and every historical result row already
published under `reports/snapshots/<utc-date>/<model>/<driver>/<role>/<suite>/`.
Renumbering (`breadth-07` → `breadth-06` after a removal) silently re-points
history at a different fault; reusing a retired id makes two different cases
share a row. Neither is ever allowed.

**Procedure — retiring a suite.** Every retired suite ends up at
`suites/<role>/deprecated/<original-suite>/`, ids and content byte-identical:

```bash
# 1. Move the whole payload, ids and content byte-identical.
git mv suites/<role>/<suite> suites/<role>/deprecated/<original-suite>
git mv fixtures/<name> suites/<role>/deprecated/<original-suite>/fixtures/<name>
git mv fixtures/<name>.FAULT.json suites/<role>/deprecated/<original-suite>/fixtures/<name>.FAULT.json
```

Rewrite the moved `suite.json`'s `fixture` and `probe.check` paths to the moved
location (`suites/<role>/deprecated/<original-suite>/fixtures/<name>` and
`…/fixtures/<name>/check.mjs`) so the audit copy is internally consistent. No
tool loads a deprecated suite — `discoverSuiteDirs` skips the `deprecated`
segment and the matrix `find` excludes it — so this rewrite is for the audit
trail only, never for execution.

The fixture directory and its record travel with the suite: leaving either
behind under `fixtures/` turns it into an issue for the static inventory
(`orphan record …` / `orphan fixture <id>`, see §1) because the moved case is no
longer discovered. Then write a dated `DEPRECATED.md` inside the moved
directory:

```markdown
# <suite> — DEPRECATED <YYYY-MM-DD>

- Date retired: <YYYY-MM-DD> (UTC)
- Reason: <why the suite/case no longer measures what it claimed>
- Replacement: <suite>/<case id>, or "none"
- Case ids: never renumbered, never reused.
- Last green run: reports/snapshots/<date>/…/<role>.table.json
```

Never edit the moved suite's `suite.json` case ids and never delete the moved
payload — the directory is the audit trail for every row already published
under that id.

**Where the exclusion is enforced.**

- `.github/workflows/suite.yml` (matrix discovery): the worklist is built with
  `find ${roots} -maxdepth 1 -name suite.json -not -path '*/deprecated/*'`
  (line 572, under the `deprecated/ exclusion (F2, WB-2.1)` comment). The
  dispatch roots are explicit and shallow, so a retired suite is not merely
  skipped by this filter — it is never named as a root either. A retired case
  therefore never spends eval tokens.
- `catalog/corpus.ts`: `discoverSuiteDirs` walks `suites/` and skips any
  directory whose repo-relative POSIX path contains a `deprecated` or
  `quarantine` segment (`EXCLUDED_SEGMENTS`, line 15), so a moved suite leaves
  the static inventory, the corpus gate, and the discovery-driven tests in
  `test/breadth.test.ts` in one step.
- `suites/<role>/deprecated/` itself is a landing zone with no `suite.json`
  (see its `README.md`), so the directory is inert even to a shallow `find`.

Excluded is not the same as forgotten: `reports/snapshots/**` keeps the retired
rows, and the `DEPRECATED.md` is the human-readable pointer from the retired id
to its replacement.

## 3. Flake quarantine protocol

**The expectation to design around.** Passing-then-passing (P→P) flips are not
exotic in agentic fix benchmarks: SWT-bench reports a 10–17% P→P rate — a patch
that passes on one run and fails on the next with identical inputs. A single
flip is therefore weak evidence that the case is broken, but a case that flips
is not usable evidence for a headline score. It must leave the scored corpus
until it has re-earned its place.

**Detect.** A flip is two rows over the same cell with identical inputs (same
fixture, same judge, same served model + driver): green in one run, red in the
next. Capture both: the dated tables under
`reports/snapshots/<utc-date>/<model>/<driver>/<role>/<suite>/<role>.table.json`
and the NDJSON journal the workflow passes via `--journal`. Do not classify a
flip by re-running until the answer looks right.

**Quarantine.** Every pulled suite ends up at
`suites/<role>/quarantine/<suite>/`, ids and content byte-identical:

```bash
git mv suites/<role>/<suite> suites/<role>/quarantine/<suite>
git mv fixtures/<name> suites/<role>/quarantine/<suite>/fixtures/<name>
git mv fixtures/<name>.FAULT.json suites/<role>/quarantine/<suite>/fixtures/<name>.FAULT.json
```

As in §2, rewrite the moved `suite.json`'s `fixture`/`probe.check` paths to the
moved location so the archived copy is internally consistent; no tool loads a
quarantined suite. Then write a dated `QUARANTINE.md` inside the moved
directory:

```markdown
# <suite> — QUARANTINED <YYYY-MM-DD>

- Date quarantined: <YYYY-MM-DD> (UTC)
- Affected case ids: <ids, unchanged — never renumbered>
- Observed flip rate: <k flips / N observations> (<P>%), first flip <date>, last flip <date>
- Evidence: reports/snapshots/<date>/<model>/<driver>/<role>/<suite>/<role>.table.json
  and journal reports/eval/<model>/<driver>/<role>/<suite>/journal (NDJSON)
- Owner: <handle>
- Review date: <YYYY-MM-DD>
- Restore criteria: ≥ 3 consecutive green both-states runs (see below)
- Suspected cause: <case defect | judge/environment | model nondeterminism | unknown>
```

**Rules.**

- A quarantined suite is never a discovery root. The matrix roots in
  `.github/workflows/suite.yml` never name a `quarantine/` path, and
  `catalog/corpus.ts` skips the `quarantine` segment, so its cases vanish from
  the corpus gate and from the discovery-driven tests as well. The landing zone
  `suites/<role>/quarantine/` carries no `suite.json`.
- Quarantined cases are never silently re-run or retried. The runner has no
  retry knob by design: a flipped case is recorded twice and then removed from
  the scored set. Do not add a retry loop, a retry flag, or a "best of N"
  reducer to hide a flip, and do not "stabilize" the case by editing its tests
  while it is still in a discovery root — the quarantine move comes first.
- A quarantined case is excluded from headline scores in both directions: it
  cannot count as a pass and cannot count as a failure. Report the quarantine
  and the cell's reduced denominator whenever a quarantined suite would have
  been part of a published aggregate.
- If the same case is quarantined twice, retire it per §2: repeated flakiness is
  a case defect, and a case defect is not fixable by more runs.

**Restore.** Restoring requires N consecutive green both-states runs with
N ≥ 3, on the case's own fixture and judge, in a scratch run that is not a
headline aggregate. Record the restoring runs in the `QUARANTINE.md` before the
move back:

```bash
git mv suites/<role>/quarantine/<suite> suites/<role>/<suite>
git mv suites/<role>/<suite>/fixtures/<name> fixtures/<name>   # and the .FAULT.json
rm suites/<role>/<suite>/QUARANTINE.md   # the restore runs are cited in the PR body
```

Anything less than N ≥ 3 consecutive green runs is not a restore — it is another
observation. If the flip was a real case defect, fix the case first, keep the
dated record, and re-verify with the §1 executing gate.

## 4. No real-repo content without a license row

Any fixture, payload, dataset row, benchmark instance, or advisory-derived case
that is adapted from content outside this repo carries an explicit license row
before it lands. The row names four things:

| field | meaning |
| --- | --- |
| source | the upstream repository, benchmark, dataset, or advisory |
| URL | the canonical public URL (or advisory id such as `CVE-…`) |
| license | the upstream license, or `no code vendored` when nothing was copied |
| vendored | what was actually copied into the tree — **usually `none`** |

**Where rows live.**

- `fixtures/<name>.FAULT.json` → `provenance` (`origin`, `generator`, `seed`,
  `engine_version`, and — for any externally derived case — `reference` and
  `license`; shape in `schema/fault.schema.json`).
- Contamination canaries → `suites/fixer-worker/canary/PROVENANCE.md` (one row
  per `canary-01..04`, each stating the public bug class, what was derived, and
  `Vendored: none`). Canary records also carry
  `provenance.origin = "public-bug-canary"` plus `provenance.reference` and
  `provenance.license`.
- Hand-seeded micro suites → `suites/fixer-worker/micro/PROVENANCE.md` and
  `suites/review-classifier/micro/PROVENANCE.md`.
- Thread payloads → `fixtures/threads/**` with the payload-to-verdict table in
  the classifier suite's `PROVENANCE.md`.

**Default posture: re-derive, don't copy.** The preferred way to seed a known
bug class is the canary pattern — reproduce the *behaviour* on a clean,
zero-dependency substrate we author, generated deterministically by
`catalog/canary-recipes.ts` → `catalog/generate-canaries.ts`, and cite the public
reference in the row. Verbatim public benchmark instances are excluded by design
(`suites/README.md`, "Provenance / contamination"): they measure benchmark recall,
not fixing skill.

**Hard rules.**

- No third-party source file, test file, or fixture payload may be copied into
  `fixtures/` (or anywhere else in the tree) unless the row names the license
  and a copy of the license text lands beside the copy or at the repo root.
- Permitted upstream licenses for vendored content: MIT, Apache-2.0, BSD-2/3-Clause,
  ISC, 0BSD. Anything else — copyleft, source-available, "all rights reserved",
  unlicensed, unknown — requires owner sign-off in the PR before it lands.
  No GPL/AGPL content ever enters the tree.
- A row is required even when the answer is "nothing was vendored": the row is
  what makes the negative auditable. `license: 'no code vendored; reference is
  documentation only'` is a complete answer.
- This is a review gate, not a machine gate: no checker can decide whether a
  fixture was derived from outside content. The lane reviewer confirms the row
  exists and matches the case; the record itself is the durable evidence, and
  `test/canary.test.ts` pins the canary rows' `reference`/`license` fields.

## 5. Contamination canaries + the asymmetry alarm

Canaries are cases whose fault classes the models have almost certainly seen
before (famous public bug classes, re-derived — see §4). They are not headline
material; they are a **contamination detector** for the headline corpus.

**Where they live and where they are reported.** `suites/fixer-worker/canary/`
only — four record-backed cases, `canary-01..04`, generated by
`catalog/generate-canaries.ts` from `catalog/canary-recipes.ts`. They are not in
`CASE_RECIPES`, not in `suites/fixer-worker/{breadth-verified,breadth-tail}`,
and not a matrix-discovery root. Their tables land in their own namespace:

```text
reports/canaries/<model>/<driver>/fixer-worker/canary/fixer-worker.table.json
reports/canaries/<model>/<driver>/fixer-worker/canary/rows.jsonl
reports/canaries/<model>/<driver>/fixer-worker/canary/journal/…
```

That mirrors the matrix convention (`reports/eval/<model>/<driver>/<role>/<suite>/`),
so a canary table can never be mistaken for, or merged into, a headline breadth
table. A canary score is never added to a breadth denominator and never appears
in a comparison table's breadth rows.

**Dispatch them separately** (one cell at a time; `--out` mirrors the suite path
under `suites/`, prefixed with the model id and driver):

```bash
node --experimental-strip-types runner/index.ts \
  --suite suites/fixer-worker/canary \
  --driver <driver> --driver-name <driver> \
  --model <served-id> --provider <provider-handle> \
  --max-tokens-per-case 60000 \
  --journal reports/canaries/<model>/<driver>/fixer-worker/canary/journal \
  --out reports/canaries/<model>/<driver>/fixer-worker/canary
```

Run canaries against **the same model/driver cell** as the breadth run, as close
in time as possible (same day, same commit): the alarm is a comparison of
contemporaneous numbers, and comparing a canary run from one week with a
breadth run from another compares two different things.

**The asymmetry alarm.** Compare the canary score against the headline breadth
score for the same cell and the same run window (the `breadth-verified` +
`breadth-tail` aggregate, canaries excluded). Treat it as a contamination signal
when either holds:

- canary score ≥ headline breadth score **+ 20 percentage points**, or
- canary miss-rate ≤ **half** the headline miss-rate (equivalently: the canary
  failure count is at most half what the breadth corpus's miss rate predicts for
  the canary case count).

Both are one-directional: canaries scoring *better* than the headline corpus is
the memorization signature (the public bug classes are recall, not skill);
canaries scoring *worse* is not a contamination signal — it usually means the
canary suite itself is mis-scored, which §3 handles if the number flips.

**On trigger.** Do not publish, quote, or act on the breadth delta. Re-audit the
headline corpus first:

1. Leakage: re-read `fixtures/<name>.FAULT.json` reachability — the record must
   stay outside the materialized fixture tree (the `reachability` gate in
   `catalog/pipeline.ts`, `assertRecordOutsideFixture`), and no prompt, task
   spec, or suite metadata may carry the canonical fix.
2. Provenance: confirm no headline case is a verbatim public benchmark instance
   or a named public bug class (§4) — those belong in the canary suite.
3. Titles/tells: check that F2P/P2P titles, repository names, and comments do
   not name the bug class in words the model has memorized.
4. Record the outcome in the snapshot PR (or the report's README): either the
   headline number is trusted after the audit, or the leaking cases are moved
   out (deprecated per §2) and the headline corpus is re-run before its numbers
   are published.

`test/hygiene.test.ts` pins the mechanical half of the separation: the canary
case ids appear only under `suites/fixer-worker/canary`, never in either breadth
suite.

## Landing zones

The four holding pens — `suites/fixer-worker/deprecated/`,
`suites/fixer-worker/quarantine/`, `suites/review-classifier/deprecated/`,
`suites/review-classifier/quarantine/` — each carry a two-line `README.md`
pointing back here and **no `suite.json`**, so discovery ignores the directory
itself and only the moved per-suite directories (each with its dated
`DEPRECATED.md` or `QUARANTINE.md`) live inside.
