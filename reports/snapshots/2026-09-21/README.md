# Snapshot 2026-09-21 — F1 real-driver matrix re-run (run 35553519022)

The F1 re-run of the five-cell axes matrix (ADR-0001 as revised 2026-09-14), dispatched via
`workflow_dispatch` on `lane/f1-lane-health` at head `7ced43c` after the F1 fixes and the interim
toolkit pin (cq-toolkit main `b06b6a3`, package version 1.0.1).

What F1 changed before the run:

- the deepseek cell requests the id the wire serves, `deepseek-flash` (WB-1.5a);
- the per-suite token cap is `--max-tokens-per-case 60000` scaled by suite size (WB-1.6), so no
  suite's tail is gated into "no row";
- the subprocess lane's `claude` CLI install allows the package postinstall and is verified by
  `claude --version` (WB-1.2 — proven on this run: `2.1.276 (Claude Code)`);
- `toolkit.lock` pins the interim post-v1.0.0 commit `b06b6a3` carrying the driver error channel
  and the `deepseek-flash` / `glm-5.3-flash` price entries (WB-1.5b);
- the runner surfaces `WorkerResult.error` — the cause channel cq-toolkit #206/#207 explicitly
  deferred to F1 — so every driver failure below is a driver-reported cause, not an inference.

**Honesty rule this snapshot is held to: no cell's zero is a driver error.** A role that cannot
produce a real score is a LOUD dispatch-only absence (with its routed toolkit issue), never a
published zero. The only tables published here are the two real classifier cells; the raw
per-cell artifacts (including the failing fixer journals) stay on the `snapshots` branch.

## Per-cell verdicts

| Cell (model / driver) | Role | Verdict | Evidence |
|---|---|---|---|
| glm-5.3-flash / ai-sdk | review-classifier | **REAL 8/10 probes**, `costUSD` 0.001941 (`modeled`) | `glm-5.3-flash/ai-sdk/review-classifier/micro/review-classifier.table.json` |
| deepseek-flash / ai-sdk | review-classifier | **REAL 10/10 probes**, `costUSD` 0.001188 (`modeled`), observed served id `deepseek-flash` | `deepseek-flash/ai-sdk/review-classifier/micro/review-classifier.table.json` |
| glm-5.3-flash / ai-sdk | fixer-worker | **DISPATCH-ONLY — loud absence** | cq-toolkit [#210](https://github.com/camerontaylor/cq-toolkit/issues/210): 3/5 endpoint header timeouts on the long tool loop + 2/5 structured-output misses |
| deepseek-flash / ai-sdk | fixer-worker | **DISPATCH-ONLY — loud absence** | cq-toolkit [#210](https://github.com/camerontaylor/cq-toolkit/issues/210): 5/5 `No object generated: could not parse the response` |
| glm-5.3-flash / claude-agent | both | **DISPATCH-ONLY — loud absence** | cq-toolkit [#209](https://github.com/camerontaylor/cq-toolkit/issues/209): `--json-schema` rejected (draft-2020-12 meta-schema URI), 0 tokens, pre-model |
| glm-5.3-flash / subprocess | both | **DISPATCH-ONLY — loud absence** | cq-toolkit [#208](https://github.com/camerontaylor/cq-toolkit/issues/208): `WorkerResult.error` not populated, 0-token failure undiagnosable |
| glm-5.3-flash / acp | — | **LOUD SKIP, no data** | preflight rc 4 / skip before eval; owner decision pending (installable CI backend vs dispatch-only) |

Denominator is probes, not rows: a classifier row carries 1 probe, so a classifier cell's
`passed/total` counts cases 1:1.

## What is proven vs what is not

- **Proven (DoD 5 mechanism + real evidence):** the full pipeline ran end-to-end with real
  drivers, and two cells produced **real scored model evidence**: the ai-sdk review-classifier
  cells for both models, priced from the interim-pinned price map. The served-id rule holds
  (deepseek rows carry the observed `deepseek-flash`); the subprocess CI-wiring fix holds (the
  CLI installs and verifies on the runner).
- **NOT model outcomes — and not published as data:** the ai-sdk fixer roles (endpoint timeouts
  and structured-output misses, cq-toolkit #210), the claude-agent lane (a pre-model
  `--json-schema` rejection, #209), and the subprocess lane (cause not surfaced, #208). These
  roles are now dispatch-only in the matrix config, so the next run emits a loud absence for
  them instead of a driver-error zero. Re-enabling a role is a one-line cell-config edit once
  its toolkit issue lands.
- **Run variance:** run 1 (`35552908933`) scored the glm classifier 9/10 and deepseek 8/10;
  this snapshot publishes run 2 (`35553519022`) at 8/10 and 10/10. Both are real scored runs at
  n=10 — report the pair, not a single number.

## Interim toolkit pin (why the lock is a SHA, not a version)

`toolkit.lock` pins the commit `b06b6a3` — the post-v1.0.0 `main` commit carrying cq-toolkit #206
(the `WorkerResult.error` seam channel), #207 (the ai-sdk/claude-agent driver fixes and the
`deepseek-flash` / `glm-5.3-flash` price-map entries), package version `1.0.1`. It is a **commit
SHA, not an npm version, because npm publish of `1.0.1` is owner-gated**: the fixtures flip PR
cannot exist pre-publish. `scripts/flip-to-published.sh` replaces this pin with the published
version after the owner publishes; until then the cost column above is computed from the tarball
build of that SHA (packed by `scripts/pack-toolkit.sh`, SHA path).

## Schema

Every published table conforms to `schema/comparison-table.schema.json` (validated in the runner
before emission; the snapshot job copies `*.table.json` verbatim).
