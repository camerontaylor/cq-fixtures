# Triage — 2026-09-18 five-cell matrix (WB-1.0 / F0)

Scope: root-cause memo for every broken lane in the first live J5 real-driver matrix
(GitHub Actions run `35392822013`, snapshot `reports/snapshots/2026-09-18/`), with no
re-spend. Each broken lane is classified as exactly one of **toolkit-defect**,
**CI-wiring**, or **lane-unavailable-on-CI**, with journal/log citations and a routed fix.
The classifier cells are largely healthy; they are cited below only as controls for the fixer failures, not re-litigated.

Method: the committed snapshot carries only `*.table.json`; the NDJSON journals and
`rows.jsonl` live in the run's uploaded artifacts. Those artifacts were downloaded and
read in full (artifact IDs in the evidence table), together with the per-cell GitHub
Actions job logs, the runner source in this repo, and the pinned toolkit source at the
`toolkit.lock` tag `phase-3-done` (commit `8fda0531cae7974b3cbf049565366099ee7ac247`,
which is what `scripts/pack-toolkit.sh` checks out on CI). No model was dispatched and no
token was spent to produce this memo.

## Evidence base

| Artifact | Cells | Notes |
|---|---|---|
| `eval-reports-glm-5.3-flash-ai-sdk` (10566461526) | glm ai-sdk fixer + classifier | journals + `rows.jsonl` + tables |
| `eval-reports-deepseek-chat-ai-sdk` (10567300291) | deepseek ai-sdk fixer + classifier | journals + `rows.jsonl` + tables |
| `eval-reports-glm-5.3-flash-claude-agent` (10566825116) | claude-agent both roles | journals + `rows.jsonl` + tables |
| `eval-reports-glm-5.3-flash-subprocess` (10567005463) | subprocess both roles | journals + `rows.jsonl` + tables |
| `eval-reports-glm-5.3-flash-acp` (10566700607) | acp | preflight died before eval; only `reports/README.md` |
| job logs 105754963274 (glm ai-sdk) / 105754963272 (deepseek ai-sdk) / 105754963242 (claude-agent) / 105754963287 (subprocess) / 105754963248 (acp) | per-cell stdout/stderr | install-step and preflight evidence; the drivers' own error text is not surfaced |

Journal paths below are given relative to the artifact root as
`eval/<model>/<driver>/<role>/micro/journal/<runId>.ndjson`.

## Summary

| Lane (model / driver / role) | Observed | Classification | Fix owner |
|---|---|---|---|
| ai-sdk fixer, both models | 5/5 cases per model (10/10 across both) `driver stopReason: error` after real spend; classifier largely healthy (glm 8/10 `job-finished` ok / 7 passed; deepseek 10/10 ok / 9 passed) | **toolkit-defect** | cq-toolkit [#203](https://github.com/camerontaylor/cq-toolkit/issues/203) |
| claude-agent, both roles | 15/15 cases `driver stopReason: error`, 0 tokens, <1 s each | **toolkit-defect** (provisional) | cq-toolkit [#204](https://github.com/camerontaylor/cq-toolkit/issues/204) |
| subprocess, both roles | 15/15 cases `driver stopReason: error`, 0 tokens, <1 s each | **CI-wiring** | cq-fixtures (F1; no upstream issue) |
| acp | preflight rc 4 before eval; no rows/tables | **lane-unavailable-on-CI** | OWNER-DECISION-PENDING (no cq-toolkit issue) |

## Lane 1 — ai-sdk fixer (glm-5.3-flash and deepseek-chat): toolkit-defect

### What the artifacts show

Both ai-sdk fixer cells dispatched 5 cases, spent real tokens on every one, and returned
`driver stopReason: error` on every one. The classifier cells on the **same driver and
provider** are largely healthy in the same jobs (glm classifier: 8/10 `job-finished` ok, 7/10 probes passed; deepseek classifier: 10/10 `job-finished` ok, 9/10 probes passed), but
the glm classifier does show the **same error class on 2 of 10 probes** — so the failure is
concentrated in, not exclusive to, the fixer path.

glm-5.3-flash ai-sdk fixer (`eval/glm-5.3-flash/ai-sdk/fixer-worker/micro/journal/d006d621-bd22-4665-89b1-1f5f207c8dd8.ndjson`), every `job-finished` is the same shape. The record below is the **micro-1** case; the cell totals that follow are the sum of all five cases:

```json
{"type":"job-finished","jobId":"micro-1","opId":"fixer-worker","inputsHash":"778a13e1…",
 "result":{"status":"failed","error":"driver stopReason: error"},
 "usage":{"input":1400,"output":302,"cacheRead":6592,"cacheWrite":0}}
```

(identical shape on micro-2…micro-5, each with its own per-case usage; `rows.jsonl` records `outcome {score:0,passed:0,total:2}`,
`costUSD: null`, wall 28.8–36.3 s/case). Cell totals: input 5304 / output 1542 /
cacheRead 35200, wall 165 084 ms (`fixer-worker.table.json`).

deepseek-chat ai-sdk fixer (`eval/deepseek-chat/ai-sdk/fixer-worker/micro/journal/fc30e2cb-9e54-4d5a-9050-cf70112e10f9.ndjson`) is the same on all 5 cases, with
wall 6.5–6.9 s/case and modeled cost recorded because the row's observed id is priced:
totals input 8088 / output 2003 / cacheRead 42112, `costUSD` 0.004285 (`costBasis: modeled`).

Corroborating control — glm-5.3-flash ai-sdk review-classifier in the same job
(`eval/glm-5.3-flash/ai-sdk/review-classifier/micro/journal/07ef168e-6498-45c5-b95e-eb4c32b1680c.ndjson`): 7 of 10
`job-finished` are `{"status":"ok","value":{"score":1,…}}`, and one further `ok`
(`thread-04`) scored 0 on the verdict — so 8/10 `job-finished` ok and 7/10 probes passed. The two failures
(`thread-01`, `thread-07`) are `driver stopReason: error` **with retained usage**
(`input 512/output 435` and `input 384/output 524`). deepseek's classifier
(`eval/deepseek-chat/ai-sdk/review-classifier/micro/journal/efa096aa-fecd-426e-8068-da53c4585738.ndjson`):
10/10 `job-finished` ok, 9/10 probes passed, zero driver errors. So the classifier path is largely healthy and the fixer path is uniformly
broken.

### Root cause (mechanism pinned to the SDK contract; the per-case throw is inferred)

The fixer is the only op that combines a **multi-step tool loop** with a **mandatory
structured output**, and the pinned toolkit driver mishandles that combination.

1. The runner constructs the fixer driver with `FIXER_OUTPUT_SCHEMA`
   (`{fixed: boolean, notes: string}`) — `runner/cli.ts` ("fixer → FIXER_OUTPUT_SCHEMA").
   It constructs the fixer invocation with the tool allowlist
   `['read','edit','run']` in `workspace-write` mode — `runner/index.ts` `FIXER_TOOL_NAMES`.
   The classifier gets `VERDICT_OUTPUT_SCHEMA` but `toolPolicy {allow: [], mode: 'none'}`.
2. The pinned ai-sdk driver passes both to one `generateText` call: `tools: toolSet` plus
   `output: Output.object({ schema })`, bounded by `stepCountIs(DEFAULT_MAX_STEPS = 8)`
   (`src/driver/ai-sdk/index.ts` at `phase-3-done`).
3. In `ai@7.0.99`, the result's `output` getter **throws `NoOutputGeneratedError` when the
   final step finishes with a `tool-calls` reason, or when it contains no text and does not
   finish with `stop`** (`node_modules/ai/dist/index.d.ts`, `GenerateTextResult.output`).
   The driver reads `result.output` unconditionally whenever `outputSchema` is set, and
   its `catch` maps any non-abort throw to `stopReason: 'error'` while keeping the folded
   step usage — and discards the error message.
4. That matches the observed signature: every fixer case spends tokens across the tool
   loop, then the object getter throws because the final step ended with tool calls (or a
   non-object answer), and the driver reports a bare `error` with real usage. The
   classifier, having no tool loop, usually reaches a `stop` step with a parseable object
   and completes; when it does not (glm `thread-01`/`thread-07`), the same getter throws
   and the same bare `error` is recorded. **Confidence:** the SDK contract and the driver
   code path are read directly; the exact per-case exception is inferred because the
   driver discards it. Confirming it requires capturing the final finish reason and the
   thrown exception alongside the usage/stopReason already recorded — issue #203,
   deliverable (a).

Ruled out — **token cap**: the run used `--max-tokens 200000` per suite invocation. The
worst fixer cell folded ~52 k tokens total (deepseek: 8088 + 2003 + 42112), far under the
cap, and a cap trip would surface as `stopReason: 'budget'` (`stopReasonOf`), not `error`.

### Why this is a toolkit defect (not a model outcome)

- The driver converts a *model formatting miss* (no structured object on the final step)
  into a *driver error*, which the runner then classifies as infrastructure — so the
  scored evidence DD-4 exists to produce is destroyed. On the classifier this already
  cost 2 of 10 glm probes their scored-0 status.
- The driver's error path drops the underlying exception entirely. Neither `WorkerResult`
  nor the runner's journal carries the message, which is why this triage cannot name the
  per-case throw from the artifacts and why WB-1's "read the journals" step cannot be
  completed as written.
- The fixer output schema and the tool loop are independent concerns; coupling a mandatory
  final object to a multi-step tool loop is the defect, and it lives in the driver's
  one-call construction, not in the fixtures suite.

### Routed fix

cq-toolkit, post-v1.0.0 patch (arrives in this repo via a `toolkit.lock` bump):
issue **[fixer-driver] ai-sdk fixer: mandatory structured output on the tool loop throws
NoOutputGeneratedError and is reported as a bare driver error** →
https://github.com/camerontaylor/cq-toolkit/issues/203.
Minimum fix: (a) capture the caught error into the verdict/journal; (b) treat a missing
final object as a *scored* schema failure (absent `structuredOutput`) rather than a driver
`error`; (c) either drop the mandatory object from tool-loop ops or request it on the
final step only.

## Lane 2 — claude-agent (glm-5.3-flash, both roles): toolkit-defect (provisional)

### What the artifacts show

All 15 cases failed identically: `driver stopReason: error`, **0 tokens**, sub-second.

- fixer (`eval/glm-5.3-flash/claude-agent/fixer-worker/micro/journal/bb7fd1d7-84bd-4e89-a6c2-0c25d8e5f7ef.ndjson`): micro-1…micro-5 each
  `{"result":{"status":"failed","error":"driver stopReason: error"},"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}`,
  wall 863/586/465/460/451 ms.
- classifier (`eval/glm-5.3-flash/claude-agent/review-classifier/micro/journal/0562d334-f2f3-4f5e-a255-c0e22d466019.ndjson`): thread-01…thread-10, same shape, wall 429–596 ms.
- Cell totals: fixer 0 tokens / 2825 ms; classifier 0 tokens / 4945 ms (`*.table.json`).

### What it is not

- **Not a missing credential.** The lane's key env `ZAI_API_KEY` is present (job log env
  block shows it masked); a missing key would throw pre-dispatch with
  `requires ZAI_API_KEY in the environment`, which the runner maps to exit 2 and **no
  rows** — but rows exist.
- **Not a blocked install script.** `npm ci` installed 245 packages on this cell with no
  `install-scripts` warning; `@anthropic-ai/claude-agent-sdk@0.3.270` and its
  `-linux-x64` native-binary optional dependency carry no postinstall (unlike the
  subprocess lane's CLI, see Lane 3). The SDK's 223 MB `claude` binary ships executable in
  the platform package.
- **Not an option-shape bug we can see.** The driver's `outputFormat {type:'json_schema',
  schema}`, `sandbox {enabled:true, failIfUnavailable:false}`, `permissionMode`,
  `mcpServers`, `allowedTools` all match the pinned SDK's declared types.

### Root cause

The failure is at the vendor boundary, before any model output: the SDK's `query()` stream
throws (or ends) with no assistant and no result frame, so `stopReasonOf` sees a
non-success `resultStatus` and returns `error` with zero usage. The driver's `catch`
swallows the exception and the SDK's child stderr is not surfaced, so the artifacts cannot
name the cause. Two facts make this a toolkit-side defect rather than a fixtures one:

- The toolkit's claude-agent lane is an **unproven live integration**: its tests drive a
  mock SDK, and the real SDK ↔ Z.AI anthropic-compat endpoint contract was never exercised
  before this matrix. The lane owns the env/endpoint injection
  (`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`), so any fix belongs in
  the driver.
- As in Lane 1, the driver discards the failure cause, so the lane cannot be diagnosed
  from CI at all.

The classification is therefore **provisional**: `toolkit-defect` names the owner of the
SDK↔endpoint contract and of the error-handling defect, and the "What it is not" checks
above rule out the fixtures-side wiring candidates we can observe (missing key, blocked
install script, mismatched option shape). It becomes definitive only after deliverable (1)
surfaces the SDK error; if that shows a fixtures-side environment cause, F1 re-routes it.

### Routed fix

cq-toolkit, post-v1.0.0 patch: issue **[fixer-driver] claude-agent lane: 0-token CI
failure with the SDK error discarded** → https://github.com/camerontaylor/cq-toolkit/issues/204.
Deliverable order: (1) capture
and surface the SDK error (verdict narration + journal); (2) re-diagnose against the
pinned SDK; (3) fix the env/option contract, or — if the SDK genuinely cannot authenticate
to the Z.AI compat endpoint with a coding-plan key — mark the lane **dispatch-only** and
have the preflight prove its absence loudly (the F1 acceptance allows either).

## Lane 3 — subprocess (glm-5.3-flash, both roles): CI-wiring

### What the artifacts show

All 15 cases failed identically: `driver stopReason: error`, **0 tokens**, ~0.4–0.5 s each.

- fixer (`eval/glm-5.3-flash/subprocess/fixer-worker/micro/journal/b6477fa8-f8c5-42eb-84bc-16cd842886f9.ndjson`): micro-1…micro-5, zero usage, wall 2682 ms total.
- classifier (`eval/glm-5.3-flash/subprocess/review-classifier/micro/journal/dc9d8575-f4f3-4a33-8d8a-4dee0d35faec.ndjson`): thread-01…thread-10, zero usage, wall 4537 ms total.
- Cell totals: 0 tokens / 2682 ms and 0 tokens / 4537 ms (`*.table.json`).

### Root cause — the CLI was never installed

The subprocess driver spawns `claude` (default binary) with
`ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` and the Z.AI key. The CI step
`npm install -g @anthropic-ai/claude-code@2.1.276` **did not run the package's
postinstall**:

```text
##[warning] ... added 2 packages in 3s
npm warn install-scripts 1 package has install scripts not yet covered by allowScripts:
npm warn install-scripts   @anthropic-ai/claude-code@2.1.276 (postinstall: node install.cjs)
npm warn install-scripts Run `npm install -g --allow-scripts=@anthropic-ai/claude-code` ...
```

(job 105754963287, "Install the subprocess lane CLI").

`@anthropic-ai/claude-code`'s `bin` target is `bin/claude.exe`, which in the published
tarball (`npm pack @anthropic-ai/claude-code@2.1.276`, inspected during this triage) is a 500-byte
**placeholder shell script** that prints
`Error: claude native binary not installed.` and exits 1; the package's `postinstall`
(`install.cjs`) is what copies the real platform binary over it. With the script blocked,
every `claude` spawn exited 1 in ~0.4 s with no result event, which the driver maps to
`stopReason: 'error'` at zero usage. The CLI's stderr was captured into the driver's
retained buffer and never surfaced, so its message does not appear in the job log — only
the install-step warning above identifies the cause.

### Routed fix

cq-fixtures CI wiring (no upstream issue). F1 changes the subprocess install step to allow
the postinstall, e.g. `npm install -g --allow-scripts=@anthropic-ai/claude-code
@anthropic-ai/claude-code@2.1.276` (or an equivalent npm `allow-scripts` config), then
re-runs the matrix. This is the plan's WB-1.2 "configure the headless agent CLI for CI".

## Lane 4 — acp (glm-5.3-flash): lane-unavailable-on-CI, OWNER-DECISION-PENDING

### What the artifacts show

The acp job produced **no eval data** — its artifact is only the generic
`reports/README.md`. The preflight hard-failed with exit 4 (infrastructure), not the
exit-3 credential-skip shape (job 105754963248):

```text
acp preflight FAILED: json-rpc error before any agent output (infrastructure):
  {"code":-32603,"message":"Internal error",
   "data":{"details":"zcode create failed: zcode backend reader exited (backend dead)"}}
[zcode-acp] provider-registry: sync threw (ENOENT: no such file or directory,
  open '/home/runner/.zcode/v2/config.json')
[zcode-acp] backend: reader exited (spawn failed: zcode not found — install the zcode CLI,
  put it on PATH, or set ZCODE_BIN)
##[error]acp preflight failed (rc 4) — infrastructure, not a credential skip
```

The harness `zcode-acp-server@0.43.3` was installed and started; what is absent is its
**backend**: the `zcode` CLI binary plus its agent-side config (`~/.zcode/v2/config.json`).
`zcode` is not an npm-installable package (the npm name `zcode` is an unrelated
placeholder), so CI cannot provision it from repo secrets. The harness therefore dies
**independently of credentials** — the missing binary is the proximate cause, and the
missing config is the credential-side half.

### Routed fix

Owner decision; no cq-toolkit issue (per the F0 brief). Options for the owner:
(i) provision a CI-installable acp backend with agent-side auth, or (ii) declare the acp
lane dispatch-only and keep the loud exit-4 preflight. The preflight is already honest —
it never published the lane as data. Tracked as **OWNER-DECISION-PENDING (agent-side
credentials / backend)**.

## Cross-cutting finding — driver errors are unobservable

Every broken lane above collapses to the single journal string
`"error":"driver stopReason: error"`. The ai-sdk, claude-agent and subprocess drivers all
`catch` the underlying failure and return a `WorkerResult` with no error text
(`src/driver/*/index.ts` at `phase-3-done`); `WorkerResult` has no narration field, and the
runner records only the mapped stop reason (`runner/index.ts`). The subprocess driver does
retain stderr and an internal narration buffer, but neither reaches the verdict, journal,
or `rows.jsonl`, and the session store lives under the runner's temp dir (not uploaded).
Consequence: the plan's WB-1.0 premise that the journals "contain the driver
`stopReason: error` payloads" is only half true — they contain the *status*, not the
payload, and no re-run can be diagnosed without first fixing this. This is folded into
both cq-toolkit issues as deliverable (a). It applies to the subprocess lane too: the fix
is toolkit-side (propagate the retained stderr/narration into the verdict and journal), so
F1's re-run should not be accepted as evidence until it lands — the subprocess lane's
*primary* fix is the cq-fixtures CI wiring above, but its *diagnosability* is the shared
toolkit change.

## Issues opened (routed upstream)

- cq-toolkit **#203** — https://github.com/camerontaylor/cq-toolkit/issues/203
  `[fixer-driver] ai-sdk fixer: mandatory structured output on the tool loop throws
  NoOutputGeneratedError, reported as a bare driver error after spend` (Lane 1; toolkit-defect)
- cq-toolkit **#204** — https://github.com/camerontaylor/cq-toolkit/issues/204
  `[fixer-driver] claude-agent lane: 0-token CI failure with the SDK error discarded —
  capture and re-diagnose` (Lane 2; toolkit-defect)

Both are post-v1.0.0 patches that reach this repo only through a `toolkit.lock` bump
(F1 / WB-1.1). Lane 3 (subprocess) and Lane 4 (acp) are not routed to cq-toolkit: Lane 3
is a cq-fixtures CI-wiring fix owned by F1, Lane 4 is an owner decision.

## Acceptance check (plan §5, row F0)

- memo committed under `reports/snapshots/2026-09-18/triage.md` — this file;
- each lane classified toolkit-defect / CI-wiring / lane-unavailable-on-CI — summary table
  above (ai-sdk fixer and claude-agent = toolkit-defect; subprocess = CI-wiring; acp =
  lane-unavailable-on-CI / owner-decision-pending);
- cq-toolkit issues opened where routed — two, URLs above.

No model was dispatched and no token was spent producing this triage.

---

## F1 addendum (2026-09-21) — re-diagnosis from the real re-run

The F1 matrix re-run dispatched the five cells with the post-v1.0.0 toolkit pinned
(`toolkit.lock` = cq-toolkit main `b06b6a3`, version 1.0.1, carrying #206 + #207), after the
fixtures-side served-id, per-suite-cap and subprocess-install fixes. The runner was extended to
surface `WorkerResult.error` (cq-toolkit #206/#207 deferred that consumption to F1), so the
causes below are the drivers' own bounded, secret-redacted messages — not inferences.

Run ids: `35552908933` (first, pre-surfacing) and `35553519022` (second, causes visible).

### What is real now
- **ai-sdk review-classifier, both models — REAL scored runs.** run 1 (`35552908933`): glm
  9/10, deepseek 8/10. run 2 (`35553519022`, the published snapshot): glm 8/10 (one
  structured-output miss), deepseek 10/10. Both priced (`costBasis: modeled`); the deepseek rows
  carry the observed served id `deepseek-flash`.
- **The subprocess CI-wiring fix worked**: `claude --version` → `2.1.276 (Claude Code)` on the
  runner. The lane's remaining failure is not the install.

### Updated per-lane classification and routed issues

| Lane | Cause (driver-reported) | Classification | Routed |
|---|---|---|---|
| ai-sdk fixer, glm-5.3-flash | 3/5 `Cannot connect to API: Headers Timeout Error`; 2/5 `No object generated: response did not match schema` / `could not parse the response` | **toolkit-defect** — no retry on the endpoint header timeout (the classifier on the same endpoint/wire is healthy), and the structured-output miss is still classified a driver error (the F0 memo's fix (b) was not taken) | cq-toolkit [#210](https://github.com/camerontaylor/cq-toolkit/issues/210) |
| ai-sdk fixer, deepseek-flash | 5/5 `No object generated: could not parse the response` | **toolkit-defect** (same structured-output classification; no timeout class here) | cq-toolkit [#210](https://github.com/camerontaylor/cq-toolkit/issues/210) |
| claude-agent, both roles | 15/15 `claude-agent driver: query failed — Claude Code process exited with code 1. stderr: Error: --json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`, 0 tokens | **toolkit-defect** — the serialised output schema carries the draft-2020-12 meta-schema URI the CLI rejects; pre-model, so the lane cannot run at all | cq-toolkit [#209](https://github.com/camerontaylor/cq-toolkit/issues/209) |
| subprocess, both roles | 15/15 `driver stopReason: error (driver reported no cause)`, 0 tokens | **toolkit-defect** — the subprocess driver does not populate `WorkerResult.error` (the #206/#207 error channel covered ai-sdk and claude-agent only), so the 0-token failure is undiagnosable | cq-toolkit [#208](https://github.com/camerontaylor/cq-toolkit/issues/208) |
| acp | preflight rc 4 / skip before eval; no `eval/` artifact | **lane-unavailable-on-CI** (unchanged) | owner decision pending |

### F1 disposition
Per the plan's WB-1.7 acceptance, a lane that cannot produce a real score must be a **loud
dispatch-only absence**, never a driver-error zero. The matrix cell config now names the
dispatch-only roles with the routed issue (`skip_roles`/`skip_reason`), and the eval loop
skips them loudly (warning + step summary + `DISPATCH-ONLY-*` marker) before any runner
invocation. The affected roles are the ai-sdk fixers (#210) and both claude-agent (#209) and
subprocess (#208) roles. The classifier cells remain real. Re-enabling a role is a one-line
cell-config edit once its toolkit issue lands.

### Re-run budget
Two full re-runs were used (the F1 bound): run 1 proved the fixes that landed and exposed the
journal-surfacing gap; run 2 captured the causes above. No further re-run is spent on
toolkit-side defects; the routed issues own the next step.
