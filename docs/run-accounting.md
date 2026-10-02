# Completed run accounting

`schema/run-accounting.schema.json` and `runner/accounting.ts` define a keyless
metadata record and report for completed eval runs. They do not dispatch work,
read provider credentials, or change runner manifests and result tables.

Each record keeps modeled USD, billed USD, raw provider credits, and row
coverage in separate fields. Modeled USD is always an explicitly modeled
observation. Billed USD and provider credits must each be either an observed
value with its source and observation window, or `status: "unknown"` with a
reason. Unknown means unavailable; it is never zero. Aggregates show a known
subtotal and unknown count, and mark the amount incomplete if any record is
unknown. A modeled amount is never used to fill billed USD.

Historical #30 proof run 36730979732 produced artifact 11111387450, 45
claude-agent rows and 90/90 probes, with modeled USD 0.1430376. The artifact
contains no actual billed USD or raw provider-credit readback, so both values
remain unknown. This metadata does not upgrade that evidence:

```json
{
  "runId": "36730979732",
  "runUrl": "https://github.com/camerontaylor/cq-fixtures/actions/runs/36730979732",
  "modeledUsd": {
    "status": "observed",
    "value": 0.1430376,
    "source": "completed run artifact modeled-cost summary",
    "window": { "description": "Completed eval run artifact 11111387450" }
  },
  "billedUsd": { "status": "unknown", "reason": "No actual billed USD in the run artifact or raw provider readback." },
  "providerCredits": { "status": "unknown", "reason": "No raw provider-credit readback is available." },
  "coverage": { "observedRows": 45, "expectedRows": 45, "observedProbes": 90, "expectedProbes": 90 }
}
```

The window above identifies the evidence being summarized. It does not claim a
provider billing ledger was observed.

Use `aggregateAccounting(records)` for the numeric report model and
`formatAccountingReport(report)` for a concise text report. Known subtotals are
accumulated in exact decimal units, so the numeric `knownSubtotal` and the
rendered text agree and neither carries binary floating-point drift. This slice is
intended for manually entered or locally readback metadata after a run has
completed; it adds no provider integration.
