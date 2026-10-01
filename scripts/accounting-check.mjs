import assert from 'node:assert/strict';
import { aggregateAccounting, formatAccountingReport, validateAccountingRecord } from '../runner/accounting.ts';

const window = { description: 'Completed eval run artifact' };
const historical = {
  runId: '36730979732',
  runUrl: 'https://github.com/camerontaylor/cq-fixtures/actions/runs/36730979732',
  modeledUsd: { status: 'observed', value: 0.1430376, source: 'run artifact modeled-cost summary', window },
  billedUsd: { status: 'unknown', reason: 'No billed USD readback.' },
  providerCredits: { status: 'unknown', reason: 'No raw provider-credit readback.' },
  coverage: { observedRows: 45, expectedRows: 45, observedProbes: 90, expectedProbes: 90 },
};

validateAccountingRecord(historical);
const report = aggregateAccounting([historical]);
assert.equal(report.modeledUsd.knownSubtotal, 0.1430376);
assert.equal(report.billedUsd.knownSubtotal, 0);
assert.equal(report.billedUsd.unknownCount, 1);
assert.equal(report.billedUsd.complete, false);
assert.equal(report.providerCredits.unknownCount, 1);
assert.equal(report.coverage.complete, true);
assert.equal(report.coverage.observedProbes, 90);
const rendered = formatAccountingReport(report);
assert.match(rendered, /Modeled USD: 0\.1430376 USD known subtotal/);
assert.match(rendered, /Billed USD: 0 USD known subtotal \(1 unknown; total incomplete\)/);

const observed = {
  ...historical,
  runId: 'next-run',
  billedUsd: { status: 'observed', value: 0.2, source: 'provider invoice export', window },
  providerCredits: { status: 'observed', value: 120, source: 'provider usage page raw credits', window },
};
const combined = aggregateAccounting([historical, observed]);
assert.equal(combined.billedUsd.knownSubtotal, 0.2);
assert.equal(combined.billedUsd.unknownCount, 1);
assert.equal(combined.billedUsd.complete, false);
assert.equal(combined.providerCredits.knownSubtotal, 120);
const decimalTotals = aggregateAccounting([
  { ...observed, runId: 'decimal-a', billedUsd: { status: 'observed', value: 0.1, source: 'test source', window } },
  { ...observed, runId: 'decimal-b', billedUsd: { status: 'observed', value: 0.2, source: 'test source', window } },
]);
assert.match(formatAccountingReport(decimalTotals), /Billed USD: 0\.3 USD known subtotal/);

assert.throws(() => validateAccountingRecord({ ...historical, modeledUsd: { status: 'unknown', reason: 'missing' } }), /modeledUsd must be observed/);
assert.throws(() => validateAccountingRecord({ ...observed, billedUsd: { status: 'observed', value: 0, window } }), /requires a source/);
assert.throws(() => validateAccountingRecord({ ...observed, billedUsd: { status: 'observe', value: 0, source: 'bad status', window } }), /unsupported amount status/);
assert.throws(() => validateAccountingRecord({ ...historical, runId: null }), /runId is required/);
assert.throws(() => validateAccountingRecord({ ...historical, billedUsd: null }), /amount must be an object/);
assert.throws(() => validateAccountingRecord({ ...historical, billedUsd: { status: 'unknown', reason: 12 } }), /unknown requires a reason/);
assert.throws(() => validateAccountingRecord({ ...historical, coverage: null }), /coverage must be an object/);
console.log('accounting direct checks passed');
