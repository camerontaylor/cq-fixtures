/** Keyless accounting metadata for already completed eval runs. */
export type ObservationWindow = {
  description: string;
};

export type ObservedAmount = {
  status: 'observed';
  value: number;
  source: string;
  window: ObservationWindow;
};

export type UnknownAmount = {
  status: 'unknown';
  reason: string;
};

export type AccountingAmount = ObservedAmount | UnknownAmount;

export interface RunAccountingRecord {
  runId: string;
  runUrl?: string;
  modeledUsd: ObservedAmount;
  billedUsd: AccountingAmount;
  providerCredits: AccountingAmount;
  coverage: { observedRows: number; expectedRows: number; observedProbes: number; expectedProbes: number };
}

export interface AmountAggregate {
  /** Sum of observed values only; not a total when complete is false. */
  knownSubtotal: number;
  unknownCount: number;
  complete: boolean;
}

export interface AccountingReport {
  runs: number;
  coverage: { observedRows: number; expectedRows: number; observedProbes: number; expectedProbes: number; complete: boolean };
  modeledUsd: AmountAggregate;
  billedUsd: AmountAggregate;
  providerCredits: AmountAggregate;
}

function validateAmount(amount: AccountingAmount, label: string): void {
  if (amount.status === 'unknown') {
    if (!amount.reason.trim()) throw new Error(`${label}: unknown requires a reason`);
    return;
  }
  if (!Number.isFinite(amount.value) || amount.value < 0) throw new Error(`${label}: value must be finite and non-negative`);
  if (typeof amount.source !== 'string' || !amount.source.trim()) throw new Error(`${label}: observed value requires a source`);
  if (typeof amount.window?.description !== 'string' || !amount.window.description.trim()) {
    throw new Error(`${label}: observed value requires an observation window`);
  }
}

export function validateAccountingRecord(record: RunAccountingRecord): void {
  if (!record.runId.trim()) throw new Error('runId is required');
  validateAmount(record.modeledUsd, 'modeledUsd');
  if (record.modeledUsd.status !== 'observed') throw new Error('modeledUsd must be observed separately from billed USD');
  validateAmount(record.billedUsd, 'billedUsd');
  validateAmount(record.providerCredits, 'providerCredits');
  const { observedRows, expectedRows, observedProbes, expectedProbes } = record.coverage;
  if (![observedRows, expectedRows, observedProbes, expectedProbes].every(Number.isInteger)
    || observedRows < 0 || expectedRows < observedRows
    || observedProbes < 0 || expectedProbes < observedProbes) {
    throw new Error('coverage requires integer rows and probes with 0 <= observed <= expected');
  }
}

function aggregate(values: readonly AccountingAmount[]): AmountAggregate {
  let knownSubtotal = 0;
  let unknownCount = 0;
  for (const item of values) {
    if (item.status === 'observed') knownSubtotal += item.value;
    else unknownCount += 1;
  }
  return { knownSubtotal, unknownCount, complete: unknownCount === 0 };
}

/** Summarize records without treating missing provider observations as zero. */
export function aggregateAccounting(records: readonly RunAccountingRecord[]): AccountingReport {
  records.forEach(validateAccountingRecord);
  return {
    runs: records.length,
    coverage: {
      observedRows: records.reduce((sum, record) => sum + record.coverage.observedRows, 0),
      expectedRows: records.reduce((sum, record) => sum + record.coverage.expectedRows, 0),
      observedProbes: records.reduce((sum, record) => sum + record.coverage.observedProbes, 0),
      expectedProbes: records.reduce((sum, record) => sum + record.coverage.expectedProbes, 0),
      complete: records.every((record) => record.coverage.observedRows === record.coverage.expectedRows
        && record.coverage.observedProbes === record.coverage.expectedProbes),
    },
    modeledUsd: aggregate(records.map((record) => record.modeledUsd)),
    billedUsd: aggregate(records.map((record) => record.billedUsd)),
    providerCredits: aggregate(records.map((record) => record.providerCredits)),
  };
}

function amountLabel(amount: AmountAggregate, unit: string): string {
  return `${amount.knownSubtotal} ${unit} known subtotal${amount.complete ? '' : ` (${amount.unknownCount} unknown; total incomplete)`}`;
}

export function formatAccountingReport(report: AccountingReport): string {
  return [
    `Runs: ${report.runs}`,
    `Coverage: ${report.coverage.observedRows}/${report.coverage.expectedRows} rows, ${report.coverage.observedProbes}/${report.coverage.expectedProbes} probes${report.coverage.complete ? '' : ' (incomplete)'}`,
    `Modeled USD: ${amountLabel(report.modeledUsd, 'USD')}`,
    `Billed USD: ${amountLabel(report.billedUsd, 'USD')}`,
    `Provider credits: ${amountLabel(report.providerCredits, 'raw credits')}`,
  ].join('\n');
}
