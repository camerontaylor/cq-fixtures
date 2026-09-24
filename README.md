# cq-fixtures

Scored per-role task suites for the portable code-quality toolkit (`cq-toolkit`): seeded-fault suites and labeled review-thread cases, executed by a thin runner over the toolkit's own ops and reported as per-role comparison tables. Greenfield, public MIT from day one.

Setup: `./scripts/pack-toolkit.sh` must run before the first `npm ci` — it packs the toolkit at the tag or commit SHA pinned in `toolkit.lock` into `vendor/`, which `npm ci` installs as the `@camerontaylor/cq-toolkit` file: dependency. Unit tests scan the runner's built output: run `npm run build` before `npm test` (CI builds first).

schema: see schema/ (phase 2)

## Reading the comparison tables

Every scored run aggregates its result rows into one comparison table per
role (`schema/comparison-table.schema.json`): **one row (cell) per
(model, driver) pair** with columns `runs`, `passed`, `total`, `score`
(passed/total summed probes), `costUSD`, `costBasis`, `wallTimeMs`, and
`tokens` — summed over the cell's rows. Historical rows marked
`invalid: workspace-unbound` propagate that marker to the cell. Their counts
and score are retained for the audit trail, but the published status must
treat them as invalid rather than as a valid model result.

**Where tables come from.** Local runner runs write
`reports/eval/<model>/<role>/<suite>/<role>.table.json` via `--out`. In CI,
`.github/workflows/suite.yml` publishes the same shape as artifacts —
`smoke-reports` (fake-driver smoke, every push/PR) and `eval-reports-<model>`
(real-driver cells) — and the workflow's snapshot job commits the eval tables
to the repo's `snapshots` branch under
`reports/snapshots/<date>/<model>/<role>/<suite>/` (main is hook-protected;
the snapshots-branch bot commit is the recorded standing deviation). The real
matrix and snapshot publisher are dispatch-only while the weekly matrix is
paused per D10; the planned schedule re-enable is W6.4/W6.7.

**The model column is the served id.** Per the served-id decision
(2026-09-14), cells request the id the wire actually serves, and the runner
records the OBSERVED served id from the driver — a gateway remap surfaces as
data, never silently rewritten.

**The cost column is token-derived USD — or an honest null.** The runner
derives `costUSD` only through the toolkit price map over the row's tokens
(DD-9, 2026-09-14): `costBasis: "modeled"` marks a derived estimate from
published rates (never actual spend; `"billed"` is reserved for
provider-reported invoicing), and `null` means the (model, provider) pair is
absent from the price map — a subscription lane reports null, a number is
never invented, and a cell sums cost only when every contributing row is
numeric (one null row forces the cell to null, never 0).

**Fixer scores carry two probes (DD-4).** A fixer-worker row's
`outcome.total` is 2: the seeded check-rerun probe (does the workspace pass
now) plus the schema-compliance probe (`runner/dimensions/schemaCompliance.ts`
— could the model hold the structured-output shape `{fixed: boolean,
notes: string}` it was asked to declare). A model's json-fidelity is
therefore visible directly in its score; classifier rows stay `total: 1`.

**The eval axes** (ADR-0001 as revised 2026-09-14): the revision removes the
ANTHROPIC-key requirement — phase-4 Claude-shaped lanes will exercise Z.AI's
anthropic-compat endpoint, while each model keeps running on its own wire
(`glm-5.3-flash` on the GLM coding wire, `deepseek-flash` on the deepseek
wire). Models vary on the `ai-sdk` driver; drivers vary on the fixed GLM
served id `glm-5.3-flash` — a constraint the runner CLI enforces per
invocation, so a cell on any non-ai-sdk driver carries exactly that served
id.
