# Triage addendum — F1b / WB-1 completion run (run 35570311785)

Scope: the WB-1.1 re-diagnosis after the toolkit fixes (#208/#209/#210/#211/#212/#213, pinned as
`5e52707`) and the runner-side class-token mapping. It updates the F0 memo
(`reports/snapshots/2026-09-18/triage.md`) and the F1 dispositions
(`reports/snapshots/2026-09-21/README.md`) for every lane. Evidence: the run's uploaded
artifacts (`eval-reports-*`), read in full — journals, `rows.jsonl`, `run.json`, tables. No new
spend; the run is the proving dispatch itself.

## Summary

| Lane (model / driver / role) | F1 state | F1b observed | Classification | Disposition |
|---|---|---|---|---|
| ai-sdk fixer (glm-5.3-flash) | dispatch-only absence (#210) | 34/45 cases `[structured-output-miss]` → real scored zeros; 11 cases `[endpoint-timeout]` → **no row** (8 step-timeout, 3 rate-limit) | **model outcome** (misses) + **endpoint transient** (absences) | honest scored-miss rows; absences loud with cause; **no toolkit issue** — #212's classification is the fix |
| ai-sdk fixer (deepseek-flash) | dispatch-only absence (#210) | 45/45 cases `[structured-output-miss]` → real scored zeros | **model outcome** | honest scored-miss rows |
| claude-agent (both roles) | dispatch-only absence (#209) | both roles real-scored (fixer 0.5, classifier 0.9) | **fixed** (#211) | re-enabled; fixer tail budget-gated |
| subprocess (both roles) | dispatch-only absence (#208) | both roles real-scored (fixer 0.5, classifier 0.9) | **fixed** (#208/#213 + F1 CI wiring) | re-enabled; fixer tail budget-gated |
| acp | lane-unavailable-on-CI | preflight hard-fail before eval | **lane-unavailable-on-CI** | owner decision pending (unchanged) |

## Lane 1 — ai-sdk fixer: split by class token

The F0/F1 failure ("driver `stopReason: error` after real spend") is now fully classified by the
toolkit's own cause token (#212), and the runner consumes it. The single error verdict becomes
two dispositions:

1. **`[structured-output-miss]` — MODEL outcome, now scored (79 cases).** glm 34/45, deepseek
   45/45. Verbatim cause:
   `ai-sdk driver: [structured-output-miss] run failed — No object generated: could not parse the response.`
   The worker spent real tokens across the fixer tool loop (read/edit/run) and never emitted a
   parseable `{fixed, notes}` object; the persisted patches are **empty** (no edits), so the
   judge probe has nothing to re-run and the schema probe has no valid output. Both DD-4 probes
   fail; the row is a real zero. This is CQ-3 calibration signal (per-model structured-output
   fidelity), not infrastructure — a model-side result the fixtures repo exists to publish.
2. **`[endpoint-timeout]` — infrastructure, now loud and rowless (11 cases).** 8 ×
   `Step timeout of 120000ms exceeded` (the driver's per-step bound, kept from #210), 3 ×
   `Failed after 2 attempts. Last error: AI_APICallError: Rate limit reached for requests` (the
   #210 retry fired and the endpoint still rate-limited — 5 cells ran concurrently on one Z.AI
   coding-plan key). These publish **no row**; the cause is in the journal and `run.json`
   `absences[]`, and the workflow emits a warning + summary + `DISPATCH-ONLY-*` marker.

**No toolkit issue is opened.** The remaining ai-sdk fixer failure is model fidelity, and the
endpoint failures are the transient class #212 already classifies correctly. The class-token
contract delivered exactly what WB-1 needed; the residual is a model/calibration result, not a
defect. The F1b re-diagnosis is recorded on cq-toolkit #210 as a closing comment (the issue is
already closed).

WB-1.1 asked for "a green real-scored fixer cell". F1b delivers a **real-scored** fixer cell for
every evaluated lane — all four matrix cells that ran (glm/ai-sdk, deepseek/ai-sdk,
claude-agent, subprocess); the zeros are honest model outcomes. It delivers no **green** ai-sdk
fixer cell: the fixer tool loop's mandatory structured output is where both flash-class models
fail. That is the honest disposition — the cell is no longer an infrastructure failure. (The acp
lane is excluded from the claim: it produced no evaluation data — its preflight failed, Lane 4.)

## Lane 2 — claude-agent: fixed (#211), budget-gated tail

Both roles real-scored. The `--json-schema` meta-URI rejection (#211 stripped the draft-2020-12
`$schema`) is gone: the fixer produced 3/6, 5/10, 10/20 (score 0.5) and the classifier 9/10,
27/30, 25/30. The fixer suites hit the token cap (`run-finished` `earlyStopReason: budget`) after
3/5, 5/12 and 10/28 cases.

## Lane 3 — subprocess: fixed (#208/#213 + CI wiring), budget-gated tail

Both roles real-scored. The F1 CI wiring holds (the CLI installs and verifies), and #213 now
populates `WorkerResult.error` on the error path — though **the cause channel is not exercised
this run**: no subprocess driver *error* occurred. The micro fixer case returned
`stopReason: budget` (an honest `budget-exhausted` row), and the fixer suites stopped early on
the cap after 1/5, 2/12 and 5/28 cases. Classifier cells: 9/10, 26/30, 27/30.

## Lane 4 — acp: unchanged

Preflight hard-fail (`rc 4`, backend dead on CI) before any model request; the lane is honestly
absent and the owner decision (installable CI backend vs dispatch-only) is still pending.

## Cross-cutting finding — the per-case token cap vs cacheRead-heavy CLI lanes

Both CLI-transport lanes (claude-agent, subprocess) report large **cache-read** usage per fixer
case (input ~18–45 k, output ~5–7 k, **cacheRead ~300–470 k**). The governor counts cache reads,
so the workflow's `--max-tokens-per-case 60000` (per-suite = 60000 × case count) is exhausted
after one to five cases and the fixer tails are gated into no-row stops. This is the WB-1.6
failure mode ("honest-but-useless absences for the back half") reappearing for the cacheRead-heavy
lanes specifically. It is a **fixtures-side cap-sizing gap**, not a driver defect, and it is
routed rather than fixed inside this one-dispatch proving PR (a re-size needs its own proving
run). Recommended: a per-lane or cache-aware per-case cap before the weekly breadth cadence
depends on the CLI fixer lanes.
