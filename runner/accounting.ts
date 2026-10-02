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
  // Surrounding whitespace would let two spellings of one identity compare
  // unequal, which duplicate detection would then miss, so it is refused.
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace`);
  }
}

/**
 * RFC 3986 component grammar. The WHATWG parser silently rewrites what it does
 * not like — `{foo}` becomes `%7Bfoo%7D`, a backslash becomes a path separator,
 * `user@@host` becomes `user%40@host` — so a record could keep provenance that
 * parses to a different URL than it reads as. Each component is therefore
 * checked against the characters RFC 3986 allows in that component.
 */
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/;
const URI_USERINFO = "[A-Za-z0-9\\-._~!$&'()*+,;=:%]*";
const URI_REG_NAME = "[A-Za-z0-9\\-._~!$&'()*+,;=%]*";
const URI_AUTHORITY = new RegExp(`^(?:${URI_USERINFO}@)?(?:\\[[0-9A-Za-z:.]+\\]|${URI_REG_NAME})(?::[0-9]*)?$`);
const URI_PATH = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/;
const URI_QUERY_OR_FRAGMENT = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/;

function isRfc3986Uri(value: string): boolean {
  const schemeEnd = value.indexOf(':');
  if (schemeEnd === -1 || !URI_SCHEME.test(value.slice(0, schemeEnd))) return false;
  let rest = value.slice(schemeEnd + 1);
  const hashAt = rest.indexOf('#');
  if (hashAt !== -1) {
    if (!URI_QUERY_OR_FRAGMENT.test(rest.slice(hashAt + 1))) return false;
    rest = rest.slice(0, hashAt);
  }
  const queryAt = rest.indexOf('?');
  if (queryAt !== -1) {
    if (!URI_QUERY_OR_FRAGMENT.test(rest.slice(queryAt + 1))) return false;
    rest = rest.slice(0, queryAt);
  }
  if (rest.startsWith('//')) {
    const pathAt = rest.indexOf('/', 2);
    const authority = pathAt === -1 ? rest.slice(2) : rest.slice(2, pathAt);
    if (!URI_AUTHORITY.test(authority)) return false;
    rest = pathAt === -1 ? '' : rest.slice(pathAt);
  }
  return URI_PATH.test(rest);
}

function validateUri(value: unknown, label: string): void {
  if (typeof value !== 'string' || !isRfc3986Uri(value)) {
    throw new Error(`${label} must be an absolute URI`);
  }
  // The grammar admits `%`, but not a malformed escape such as `%zz`, which the
  // published schema's `format: uri` rejects.
  if (/%(?![0-9A-Fa-f]{2})/.test(value)) {
    throw new Error(`${label} must be an absolute URI with valid percent escapes`);
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
  // Safe integers, not merely integers: Number.isInteger(Number.MAX_VALUE) is
  // true, and two such counts would sum to an Infinity coverage total reported
  // as complete.
  if (![observedRows, expectedRows, observedProbes, expectedProbes].every(Number.isSafeInteger)
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
    return dot === -1 ? 0 : text.length - dot - 1;
  }
  const mantissa = text.slice(0, exponentIndex);
  const exponent = Number(text.slice(exponentIndex + 1));
  const dot = mantissa.indexOf('.');
  const mantissaDecimals = dot === -1 ? 0 : mantissa.length - dot - 1;
  return Math.max(mantissaDecimals - exponent, 0);
}

/**
 * The value as an integer count of 10^-scale units, read from its shortest
 * round-trip decimal text rather than computed by floating-point multiplication.
 * Multiplying can land off the true integer by more than half a unit once the
 * magnitude is large (4186.220359827466 * 1e12 rounds up to ...467), silently
 * changing a supported observation.
 */
function scaledInteger(value: number, scale: number): bigint {
  const text = String(value);
  const exponentIndex = text.indexOf('e');
  const mantissa = exponentIndex === -1 ? text : text.slice(0, exponentIndex);
  const exponent = exponentIndex === -1 ? 0 : Number(text.slice(exponentIndex + 1));
  const dot = mantissa.indexOf('.');
  const mantissaDecimals = dot === -1 ? 0 : mantissa.length - dot - 1;
  const digits = BigInt(mantissa.replace('.', ''));
  return digits * 10n ** BigInt(scale - mantissaDecimals + exponent);
}

/**
 * Sum exact decimal values so the caller sees the total they expect
 * (0.1 + 0.2 === 0.3) rather than the binary artifact 0.30000000000000004.
 * Anything this cannot represent exactly is refused rather than approximated:
 * an ordinary-addition fallback silently drops an observed amount (1e20 + 1
 * returns 1e20), which is a worse accounting defect than float drift.
 */
function sumObserved(values: readonly number[]): number {
  // Precision beyond the supported scale is refused, so an imported
  // 0.30000000000000004 is not quietly reported as 0.3.
  for (const value of values) {
    if (decimalPlaces(value) > MAX_SUM_SCALE) {
      throw new Error('observed amounts exceed the supported decimal precision');
    }
  }
  const scale = values.reduce((widest, value) => Math.max(widest, decimalPlaces(value)), 0);
  const scaled = values.reduce((total, value) => total + scaledInteger(value, scale), 0n);
  // A total past safe-integer range would be silently rounded on the way back,
  // dropping an observed amount rather than merely drifting.
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('observed amounts exceed the supported decimal precision');
  }
  return Number(scaled) / 10 ** scale;
}

function aggregate(values: readonly AccountingAmount[]): AmountAggregate {
  const observed: number[] = [];
  let unknownCount = 0;
  for (const item of values) {
    if (item.status === 'observed') observed.push(item.value);
    else unknownCount += 1;
  }
  const knownSubtotal = sumObserved(observed);
  // Individually finite values can still overflow when added. An infinite
  // subtotal must not be reported as a complete monetary amount.
  if (!Number.isFinite(knownSubtotal)) {
    throw new Error('observed values overflow: the known subtotal is not a finite amount');
  }
  return {
    knownSubtotal,
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
    // Copy so later mutation of the source record cannot retarget this report.
    unit = { provider: value.unit.provider, account: value.unit.account, denomination: value.unit.denomination };
  }
  const totals = aggregate(values);
  // An unknown credit observation carries no unit identity, so publishing the
  // observed unit beside it would imply the unknown amount belongs to that unit.
  return totals.unknownCount > 0 ? { ...totals } : { ...totals, ...(unit === undefined ? {} : { unit }) };
}

/** Summarize records without treating missing provider observations as zero. */
export function aggregateAccounting(records: readonly RunAccountingRecord[]): AccountingReport {
  const seenRunIds = new Set<string>();
  for (const record of records) {
    validateAccountingRecord(record);
    if (seenRunIds.has(record.runId)) throw new Error(`duplicate runId '${record.runId}'`);
    seenRunIds.add(record.runId);
  }
  const coverage = {
    observedRows: records.reduce((sum, record) => sum + record.coverage.observedRows, 0),
    expectedRows: records.reduce((sum, record) => sum + record.coverage.expectedRows, 0),
    observedProbes: records.reduce((sum, record) => sum + record.coverage.observedProbes, 0),
    expectedProbes: records.reduce((sum, record) => sum + record.coverage.expectedProbes, 0),
  };
  // Each count is a safe integer on its own, but their sum can still leave the
  // safe-integer range and lose the exact total, so the reductions are checked
  // too rather than reporting an off-by-one coverage figure as complete.
  if (!Object.values(coverage).every(Number.isSafeInteger)) {
    throw new Error('coverage totals exceed safe-integer precision');
  }
  return {
    runs: records.length,
    coverage: {
      ...coverage,
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

/**
 * Replace characters that renderers treat as line boundaries so an identity
 * field cannot forge a report line. Covers the C0 range, DEL, the C1 next-line
 * control U+0085, and the Unicode line and paragraph separators U+2028/U+2029.
 */
function escapeControlCharacters(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f\u0085\u2028\u2029]/g,
    (char) => `\\u${char.codePointAt(0)?.toString(16).padStart(4, '0')}`,
  );
}

/** Escape separators so distinct identities never render to the same label. */
function escapeIdentityComponent(value: string): string {
  return escapeControlCharacters(value.replace(/\\/g, '\\\\').replace(/\//g, '\\/'));
}

export function formatAccountingReport(report: AccountingReport): string {
  const unit = report.providerCredits.unit;
  // The denomination is rendered twice — in the identity and in the amount
  // label — so both uses must be escaped or a newline in it forges a line.
  const creditUnit = unit === undefined
    ? 'unit unavailable'
    : [unit.provider, unit.account, unit.denomination].map(escapeIdentityComponent).join('/');
  const creditAmountUnit = unit === undefined
    ? 'raw credits'
    : escapeControlCharacters(unit.denomination);
  return [
    `Runs: ${report.runs}`,
    `Coverage: ${report.coverage.observedRows}/${report.coverage.expectedRows} rows, ${report.coverage.observedProbes}/${report.coverage.expectedProbes} probes${report.coverage.complete ? '' : ' (incomplete)'}`,
    `Modeled USD: ${amountLabel(report.modeledUsd, 'USD')}`,
    `Billed USD: ${amountLabel(report.billedUsd, 'USD')}`,
    `Provider credits (${creditUnit}): ${amountLabel(report.providerCredits, creditAmountUnit)}`,
  ].join('\n');
}
