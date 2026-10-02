import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { aggregateAccounting, formatAccountingReport, validateAccountingRecord } from '../runner/accounting.ts';

const schema = JSON.parse(readFileSync(new URL('../schema/run-accounting.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

const window = { description: 'Completed eval run artifact' };
const creditUnit = { provider: 'zai', account: 'fixture-eval', denomination: 'raw-credits' };
const historical = {
  runId: '36730979732',
  runUrl: 'https://github.com/camerontaylor/cq-fixtures/actions/runs/36730979732',
  modeledUsd: { status: 'observed', value: 0.1430376, source: 'run artifact modeled-cost summary', window },
  billedUsd: { status: 'unknown', reason: 'No billed USD readback.' },
  providerCredits: { status: 'unknown', reason: 'No raw provider-credit readback.' },
  coverage: { observedRows: 45, expectedRows: 45, observedProbes: 90, expectedProbes: 90 },
};

function assertSchemaValid(record) {
  assert.equal(validateSchema(record), true, JSON.stringify(validateSchema.errors));
}

function assertSchemaInvalid(record) {
  assert.equal(validateSchema(record), false, 'invalid record unexpectedly matched the published schema');
}

function assertInvalidRecord(record, message) {
  assert.throws(() => validateAccountingRecord(record), message);
  assertSchemaInvalid(record);
}

validateAccountingRecord(historical);
assertSchemaValid(historical);
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
assert.equal(report.billedUsd.observedCount, 0);
assert.match(rendered, /Billed USD: no observed amount \(1 unknown; total incomplete\)/);
assert.match(rendered, /Provider credits \(unit unavailable\): no observed amount \(1 unknown; total incomplete\)/);

const observed = {
  ...historical,
  runId: 'next-run',
  billedUsd: { status: 'observed', value: 0.2, source: 'provider invoice export', window },
  providerCredits: {
    status: 'observed', value: 120, source: 'provider usage page raw credits', window, unit: creditUnit,
  },
};
validateAccountingRecord(observed);
assertSchemaValid(observed);
const combined = aggregateAccounting([historical, observed]);
assert.equal(combined.billedUsd.knownSubtotal, 0.2);
assert.equal(combined.billedUsd.unknownCount, 1);
assert.equal(combined.billedUsd.complete, false);
assert.equal(combined.providerCredits.knownSubtotal, 120);
assert.deepEqual(combined.providerCredits.unit, creditUnit);

const sameUnit = { ...observed, runId: 'same-unit-run' };
assert.equal(aggregateAccounting([observed, sameUnit]).providerCredits.knownSubtotal, 240);
const differentUnit = {
  ...observed,
  runId: 'different-unit-run',
  providerCredits: {
    ...observed.providerCredits,
    unit: { ...creditUnit, account: 'other-account' },
  },
};
assertSchemaValid(differentUnit);
assert.throws(
  () => aggregateAccounting([observed, differentUnit]),
  /cannot aggregate unlike provider\/account\/denomination units/,
);
assert.throws(() => aggregateAccounting([historical, historical]), /duplicate runId '36730979732'/);

const decimalTotals = aggregateAccounting([
  { ...observed, runId: 'decimal-a', billedUsd: { status: 'observed', value: 0.1, source: 'test source', window } },
  { ...observed, runId: 'decimal-b', billedUsd: { status: 'observed', value: 0.2, source: 'test source', window } },
]);
assert.match(formatAccountingReport(decimalTotals), /Billed USD: 0\.3 USD known subtotal/);

assert.throws(() => validateAccountingRecord({ ...historical, modeledUsd: { status: 'unknown', reason: 'missing' } }), /modeledUsd must be observed/);
assert.throws(() => validateAccountingRecord({ ...observed, billedUsd: { status: 'observed', value: 0, window } }), /source/);
assert.throws(() => validateAccountingRecord({ ...observed, billedUsd: { status: 'observe', value: 0, source: 'bad status', window } }), /unsupported amount status/);
assert.throws(() => validateAccountingRecord({ ...historical, runId: null }), /runId/);
assert.throws(() => validateAccountingRecord({ ...historical, billedUsd: null }), /amount must be an object/);
assert.throws(() => validateAccountingRecord({ ...historical, billedUsd: { status: 'unknown', reason: 12 } }), /reason/);
assert.throws(() => validateAccountingRecord({ ...historical, coverage: null }), /coverage/);

assertInvalidRecord({ ...historical, unexpected: true }, /unsupported property unexpected/);
assertInvalidRecord({ ...historical, runUrl: 'not a URI' }, /runUrl must be an absolute URI/);
assertInvalidRecord({ ...historical, coverage: { ...historical.coverage, extra: 1 } }, /coverage: unsupported property extra/);
assertInvalidRecord({
  ...historical,
  modeledUsd: { ...historical.modeledUsd, extra: true },
}, /modeledUsd: unsupported property extra/);
assertInvalidRecord({
  ...historical,
  modeledUsd: { ...historical.modeledUsd, window: { ...window, extra: true } },
}, /modeledUsd.window: unsupported property extra/);
assertInvalidRecord({
  ...historical,
  billedUsd: { ...historical.billedUsd, value: 0 },
}, /billedUsd: unsupported property value/);
assertInvalidRecord({
  ...observed,
  providerCredits: { ...observed.providerCredits, source: 'raw credits', unit: undefined },
}, /unit/);
assertInvalidRecord({
  ...observed,
  providerCredits: {
    ...observed.providerCredits,
    unit: { ...creditUnit, secret: 'must-not-be-a-field' },
  },
}, /unit: unsupported property secret/);

assert.throws(() => validateAccountingRecord({
  ...historical,
  coverage: { ...historical.coverage, observedRows: 46 },
}), /coverage requires integer rows and probes/);
console.log('accounting runtime and published-schema checks passed');
