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

/** A non-secret identity for one provider's raw-credit denomination. */
export interface ProviderCreditUnit {
  provider: string;
  account: string;
  denomination: string;
}

export interface ObservedProviderCredits extends ObservedAmount {
  unit: ProviderCreditUnit;
}

export type ProviderCreditsAmount = ObservedProviderCredits | UnknownAmount;

export interface RunAccountingRecord {
  runId: string;
  runUrl?: string;
  modeledUsd: ObservedAmount;
  billedUsd: AccountingAmount;
  providerCredits: ProviderCreditsAmount;
  coverage: { observedRows: number; expectedRows: number; observedProbes: number; expectedProbes: number };
}

export interface AmountAggregate {
  /**
   * Sum of observed values only; not a total when complete is false. The sum is
   * accumulated in exact decimal units, so it carries no binary floating-point
   * drift and is safe to serialize or compare against a budget threshold.
   */
  knownSubtotal: number;
  observedCount: number;
  unknownCount: number;
  complete: boolean;
}

export interface ProviderCreditsAggregate extends AmountAggregate {
  /** Present when at least one observed credit value supplied its unit identity. */
  unit?: ProviderCreditUnit;
}

export interface AccountingReport {
  runs: number;
  coverage: { observedRows: number; expectedRows: number; observedProbes: number; expectedProbes: number; complete: boolean };
  modeledUsd: AmountAggregate;
  billedUsd: AmountAggregate;
  providerCredits: ProviderCreditsAggregate;
}

type PlainRecord = Record<string, unknown>;

function assertObject(value: unknown, label: string): PlainRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as PlainRecord;
}

function assertShape(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): PlainRecord {
  const object = assertObject(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) throw new Error(`${label}: missing ${key}`);
  }
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new Error(`${label}: unsupported property ${key}`);
  }
  return object;
}

function nonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function validateUri(value: unknown, label: string): void {
  if (typeof value !== 'string' || value !== value.trim() || /\s/.test(value)
    || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    throw new Error(`${label} must be an absolute URI`);
  }
  try {
    new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URI`);
  }
}

function validateCreditUnit(value: unknown, label: string): ProviderCreditUnit {
  const unit = assertShape(value, label, ['provider', 'account', 'denomination']);
  nonEmptyString(unit.provider, `${label}.provider`);
  nonEmptyString(unit.account, `${label}.account`);
  nonEmptyString(unit.denomination, `${label}.denomination`);
  return {
    provider: unit.provider,
    account: unit.account,
    denomination: unit.denomination,
  };
}

function validateAmount(amount: unknown, label: string, creditUnitRequired = false): void {
  const object = assertObject(amount, `${label}: amount`);
  if (object.status === 'unknown') {
    const unknown = assertShape(object, label, ['status', 'reason']);
    nonEmptyString(unknown.reason, `${label}.reason`);
    return;
  }
  if (object.status !== 'observed') throw new Error(`${label}: unsupported amount status`);
  const observed = assertShape(
    object,
    label,
    ['status', 'value', 'source', 'window', ...(creditUnitRequired ? ['unit'] : [])],
  );
  if (typeof observed.value !== 'number' || !Number.isFinite(observed.value) || observed.value < 0) {
    throw new Error(`${label}: value must be finite and non-negative`);
  }
  nonEmptyString(observed.source, `${label}.source`);
  const window = assertShape(observed.window, `${label}.window`, ['description']);
  nonEmptyString(window.description, `${label}.window.description`);
  if (creditUnitRequired) validateCreditUnit(observed.unit, `${label}.unit`);
}

export function validateAccountingRecord(record: RunAccountingRecord): void {
  const value = assertShape(
    record,
    'record',
    ['runId', 'modeledUsd', 'billedUsd', 'providerCredits', 'coverage'],
    ['runUrl'],
  );
  nonEmptyString(value.runId, 'runId');
  if (Object.prototype.hasOwnProperty.call(value, 'runUrl')) validateUri(value.runUrl, 'runUrl');
  validateAmount(value.modeledUsd, 'modeledUsd');
  if ((value.modeledUsd as PlainRecord).status !== 'observed') {
    throw new Error('modeledUsd must be observed separately from billed USD');
  }
  validateAmount(value.billedUsd, 'billedUsd');
  validateAmount(value.providerCredits, 'providerCredits', true);
  const coverage = assertShape(
    value.coverage,
    'coverage',
    ['observedRows', 'expectedRows', 'observedProbes', 'expectedProbes'],
  );
  // SAFETY: assertShape above guarantees the four required keys exist and no
  // others are present, so the value already has the coverage field's shape.
  const { observedRows, expectedRows, observedProbes, expectedProbes } = coverage as unknown as RunAccountingRecord['coverage'];
  if (![observedRows, expectedRows, observedProbes, expectedProbes].every(Number.isInteger)
    || observedRows < 0 || expectedRows < observedRows
    || observedProbes < 0 || expectedProbes < observedProbes) {
    throw new Error('coverage requires integer rows and probes with 0 <= observed <= expected');
  }
}

/** Upper bound on decimal places summed exactly; keeps the scaled total a safe integer. */
const MAX_SUM_SCALE = 12;

/**
 * Fractional digits in a number's shortest round-trip form. Exponent forms such
 * as `1e-7` or `1.5e-7` carry their decimals in the mantissa, shifted by the
 * exponent; reading only up to the decimal point would report zero places and
 * silently round the amount away.
 */
function decimalPlaces(value: number): number {
  const text = String(value);
  const exponentIndex = text.indexOf('e');
  if (exponentIndex === -1) {
    const dot = text.indexOf('.');
    return dot === -1 ? 0 : Math.min(text.length - dot - 1, MAX_SUM_SCALE);
  }
  const mantissa = text.slice(0, exponentIndex);
  const exponent = Number(text.slice(exponentIndex + 1));
  const dot = mantissa.indexOf('.');
  const mantissaDecimals = dot === -1 ? 0 : mantissa.length - dot - 1;
  return Math.min(Math.max(mantissaDecimals - exponent, 0), MAX_SUM_SCALE);
}

/**
 * Sum by way of scaled integers so the caller sees the decimal total it expects
 * (0.1 + 0.2 === 0.3) rather than the binary artifact 0.30000000000000004.
 * An amount the chosen scale cannot hold exactly is never rounded away: the sum
 * falls back to ordinary addition, because a silently dropped amount is worse
 * than float drift. The same fallback covers magnitudes too large to scale.
 */
function sumObserved(values: readonly number[]): number {
  const plain = (): number => values.reduce((total, value) => total + value, 0);
  const scale = values.reduce((widest, value) => Math.max(widest, decimalPlaces(value)), 0);
  const factor = 10 ** scale;
  let scaled = 0;
  for (const value of values) {
    const exact = value * factor;
    const rounded = Math.round(exact);
    if (rounded !== exact) return plain();
    scaled += rounded;
  }
  if (!Number.isSafeInteger(scaled)) return plain();
  return scaled / factor;
}

function aggregate(values: readonly AccountingAmount[]): AmountAggregate {
  const observed: number[] = [];
  let unknownCount = 0;
  for (const item of values) {
    if (item.status === 'observed') observed.push(item.value);
    else unknownCount += 1;
  }
  return {
    knownSubtotal: sumObserved(observed),
    observedCount: observed.length,
    unknownCount,
    complete: unknownCount === 0,
  };
}

function sameCreditUnit(left: ProviderCreditUnit, right: ProviderCreditUnit): boolean {
  return left.provider === right.provider
    && left.account === right.account
    && left.denomination === right.denomination;
}

function aggregateCredits(values: readonly ProviderCreditsAmount[]): ProviderCreditsAggregate {
  let unit: ProviderCreditUnit | undefined;
  for (const value of values) {
    if (value.status !== 'observed') continue;
    if (unit !== undefined && !sameCreditUnit(unit, value.unit)) {
      throw new Error('providerCredits: cannot aggregate unlike provider/account/denomination units');
    }
    unit = value.unit;
  }
  return { ...aggregate(values), ...(unit === undefined ? {} : { unit }) };
}

/** Summarize records without treating missing provider observations as zero. */
export function aggregateAccounting(records: readonly RunAccountingRecord[]): AccountingReport {
  const seenRunIds = new Set<string>();
  for (const record of records) {
    validateAccountingRecord(record);
    if (seenRunIds.has(record.runId)) throw new Error(`duplicate runId '${record.runId}'`);
    seenRunIds.add(record.runId);
  }
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
    providerCredits: aggregateCredits(records.map((record) => record.providerCredits)),
  };
}

function amountLabel(amount: AmountAggregate, unit: string): string {
  if (amount.observedCount === 0) {
    return amount.unknownCount === 0
      ? `no observed amount`
      : `no observed amount (${amount.unknownCount} unknown; total incomplete)`;
  }
  // knownSubtotal is already exact-decimal, so the rendered text and the numeric
  // report field always agree.
  const subtotal = String(amount.knownSubtotal);
  return `${subtotal} ${unit} known subtotal${amount.complete ? '' : ` (${amount.unknownCount} unknown; total incomplete)`}`;
}

export function formatAccountingReport(report: AccountingReport): string {
  const creditUnit = report.providerCredits.unit === undefined
    ? 'unit unavailable'
    : `${report.providerCredits.unit.provider}/${report.providerCredits.unit.account}/${report.providerCredits.unit.denomination}`;
  return [
    `Runs: ${report.runs}`,
    `Coverage: ${report.coverage.observedRows}/${report.coverage.expectedRows} rows, ${report.coverage.observedProbes}/${report.coverage.expectedProbes} probes${report.coverage.complete ? '' : ' (incomplete)'}`,
    `Modeled USD: ${amountLabel(report.modeledUsd, 'USD')}`,
    `Billed USD: ${amountLabel(report.billedUsd, 'USD')}`,
    `Provider credits (${creditUnit}): ${amountLabel(report.providerCredits, report.providerCredits.unit?.denomination ?? 'raw credits')}`,
  ].join('\n');
}
