import { describe, expect, it } from 'vitest';
import {
  OPERATORS,
  checkOperatorAssignment,
  discriminationEligible,
  operatorsForBand,
  trivialProneOperators,
  type BugType,
} from '../catalog/operators.ts';
import {
  applyMutant,
  catalogStrykerMutators,
  generateBabelMutants,
  generateForOperator,
  generateTsMorphMutants,
  tsMorphOperatorIds,
} from '../catalog/generate.ts';
import { faultRecordRelPath, parseFaultRecord } from '../catalog/fault.ts';

const BUG_TYPES: readonly BugType[] = [
  'missing logic',
  'operator misuse',
  'variable misuse',
  'value misuse',
  'excess logic',
  'function misuse',
];

describe('operator catalog metadata (plan WB-2.2)', () => {
  it('carries the full 24-operator v1 catalog with unique ids', () => {
    expect(OPERATORS).toHaveLength(24);
    expect(new Set(OPERATORS.map((o) => o.id)).size).toBe(24);
  });

  it('every operator declares a HumanEvalFix bug_type and a non-empty band set', () => {
    for (const op of OPERATORS) {
      expect(BUG_TYPES, `operator ${op.id} bug_type`).toContain(op.bugType);
      expect(op.bands.length, `operator ${op.id} bands`).toBeGreaterThan(0);
      for (const band of op.bands) expect(['easy', 'medium', 'hard']).toContain(band);
    }
  });

  it('has exactly the three trivial-prone operators, restricted to the easy tier', () => {
    // Digest §7: constant ±1 / literal change, remove loop, empty block/arrow.
    expect(trivialProneOperators().map((o) => o.id).sort()).toEqual(['constant-delta', 'empty-block', 'remove-loop']);
    for (const op of trivialProneOperators()) {
      expect(op.bands, `${op.id} must be easy-only`).toEqual(['easy']);
      expect(discriminationEligible(op), `${op.id} is excluded from discrimination scoring`).toBe(false);
    }
  });

  it('operatorsForBand never returns a trivial-prone operator above easy', () => {
    expect(operatorsForBand('medium').some((o) => o.trivialProne)).toBe(false);
    expect(operatorsForBand('hard').some((o) => o.trivialProne)).toBe(false);
    expect(operatorsForBand('easy').some((o) => o.trivialProne)).toBe(true);
  });

  it('checkOperatorAssignment rejects unknown operators and trivial-prone misuse', () => {
    expect(checkOperatorAssignment('no-such-operator', 'easy')).toMatchObject({ ok: false });
    expect(checkOperatorAssignment('constant-delta', 'medium')).toMatchObject({ ok: false });
    expect(checkOperatorAssignment('constant-delta', 'hard')).toMatchObject({ ok: false });
    expect(checkOperatorAssignment('constant-delta', 'easy')).toEqual({ ok: true });
    expect(checkOperatorAssignment('arithmetic-swap', 'hard')).toEqual({ ok: true });
  });

  it('splits the catalog across the two engines as the digest specifies', () => {
    const tsMorph = OPERATORS.filter((o) => o.engine === 'ts-morph').map((o) => o.id).sort();
    expect(tsMorph).toEqual(
      ['default-param-removal', 'non-null-overreach', 'promise-all-sequential', 'radix-coercion-drop', 'shared-reference-return'].sort(),
    );
    expect([...tsMorphOperatorIds()].sort()).toEqual(
      ['default-param-removal', 'non-null-overreach', 'promise-all-sequential', 'radix-coercion-drop', 'shared-reference-return'].sort(),
    );
    expect(OPERATORS.filter((o) => o.engine === 'babel')).toHaveLength(19);
  });

  it('exposes the StrykerJS NodeMutator names it draws from', () => {
    const names = catalogStrykerMutators();
    for (const expected of ['ArithmeticOperator', 'AssignmentOperator', 'EqualityOperator', 'LogicalOperator', 'OptionalChaining', 'ConditionalExpression']) {
      expect(names, `catalog must map StrykerJS ${expected}`).toContain(expected);
    }
  });

  it('every operator names its source (transferred vs authored)', () => {
    for (const op of OPERATORS) expect(['stryker', 'swe-smith', 'author']).toContain(op.source);
    expect(OPERATORS.filter((o) => o.source === 'author').map((o) => o.id).sort()).toEqual(
      ['default-param-removal', 'non-null-overreach', 'promise-all-sequential', 'radix-coercion-drop', 'shared-reference-return'].sort(),
    );
  });
});

describe('catalog engines are mutant generators (smoke)', () => {
  it('StrykerJS instrumenter generates an arithmetic-swap fault and applyMutant applies it', async () => {
    const source = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
    const mutants = await generateBabelMutants(source, 'sample.ts', { operatorId: 'arithmetic-swap' });
    expect(mutants.length, 'expected at least one arithmetic mutant').toBeGreaterThan(0);
    const applied = mutants.map((m) => applyMutant(source, m));
    expect(applied.some((s) => s.includes('a - b')), 'the + mutant must offer a - b').toBe(true);
    expect(applied.every((s) => s !== source), 'every generated mutant changes the source').toBe(true);
  });

  it('ts-morph generates one fault per TS-specific operator', () => {
    const cases: Array<{ operatorId: string; source: string; contains: string }> = [
      {
        operatorId: 'shared-reference-return',
        source: 'export function copy(xs: number[]): number[] {\n  return [...xs];\n}\n',
        contains: 'return xs;',
      },
      {
        operatorId: 'promise-all-sequential',
        source: 'export async function run(xs: number[]): Promise<number[]> {\n  return await Promise.all(xs.map(async (x) => x + 1));\n}\n',
        contains: 'await (xs.map',
      },
      {
        operatorId: 'default-param-removal',
        source: 'export function f(x: number = 1): number {\n  return x;\n}\n',
        contains: '(x: number)',
      },
      {
        operatorId: 'non-null-overreach',
        source: 'export function f(o?: { a: number }): number {\n  return o?.a ?? 0;\n}\n',
        contains: 'o!.a',
      },
      {
        operatorId: 'non-null-overreach',
        source: 'export function f(o?: number[]): number {\n  return o?.[0] ?? 0;\n}\n',
        contains: 'o![0]',
      },
      {
        operatorId: 'radix-coercion-drop',
        source: 'export function f(s: string): number {\n  return parseInt(s, 10);\n}\n',
        contains: 'parseInt(s)',
      },
    ];
    for (const { operatorId, source, contains } of cases) {
      const mutants = generateTsMorphMutants(source, 'sample.ts', operatorId);
      expect(mutants.length, `${operatorId} should generate a mutant`).toBeGreaterThan(0);
      expect(applyMutant(source, mutants[0]!), `${operatorId} applied fault`).toContain(contains);
    }
  });

  it('authored Babel transforms generate the SWE-smith-derived operators', async () => {
    const cases: Array<{ operatorId: string; source: string; check: (applied: string) => void }> = [
      { operatorId: 'constant-delta', source: 'export const n = 2;\n', check: (a) => expect(a).toContain('const n = 3') },
      { operatorId: 'operand-swap', source: 'export function f(a: number, b: number): number {\n  return a - b;\n}\n', check: (a) => expect(a).toContain('b - a') },
      { operatorId: 'argument-swap', source: 'export function f(a: number, b: number): number {\n  return g(a, b);\n}\n', check: (a) => expect(a).toContain('g(b, a)') },
      {
        operatorId: 'if-else-invert',
        source: 'export function f(x: boolean): number {\n  if (x) {\n    return 1;\n  } else {\n    return 2;\n  }\n}\n',
        check: (a) => expect(a).toContain('return 2;\n  } else {\n    return 1;'),
      },
      {
        operatorId: 'remove-loop',
        source: 'export function f(xs: number[]): void {\n  for (let i = 0; i < xs.length; i++) {\n    void xs[i];\n  }\n}\n',
        check: (a) => expect(a).not.toContain('for ('),
      },
      { operatorId: 'remove-conditional', source: 'export function f(x: boolean): void {\n  if (x) {\n    void x;\n  }\n}\n', check: (a) => expect(a).not.toContain('if (x)') },
      { operatorId: 'remove-assignment', source: 'export function f(): number {\n  let x = 1;\n  x = 2;\n  return x;\n}\n', check: (a) => expect(a).not.toContain('x = 2;') },
    ];
    for (const { operatorId, source, check } of cases) {
      const mutants = await generateForOperator(source, 'sample.ts', operatorId);
      expect(mutants.length, `${operatorId} should generate a mutant`).toBeGreaterThan(0);
      check(applyMutant(source, mutants[0]!));
    }
  });

  it('generateForOperator dispatches by engine', async () => {
    const babel = await generateForOperator('export const x = 1 + 2;\n', 'a.ts', 'arithmetic-swap');
    expect(babel.length).toBeGreaterThan(0);
    const tsMorph = await generateForOperator('export function f(x: number = 1): number {\n  return x;\n}\n', 'a.ts', 'default-param-removal');
    expect(tsMorph.length).toBeGreaterThan(0);
    await expect(generateForOperator('export const x = 1;\n', 'a.ts', 'nope')).rejects.toThrow(/unknown operator/);
  });
});

describe('FAULT.json channel loader (plan WB-2.1)', () => {
  const validRecord = {
    bug_type: 'operator misuse',
    failure_symptoms: 'sumRange excludes its upper bound.',
    operator: 'equality-boundary',
    difficulty: 'easy',
    provenance: { origin: 'operator-catalog', generator: 'catalog:babel:EqualityOperator', seed: 7, engine_version: '@stryker-mutator/instrumenter@10.0.0' },
    validation: { f2p: ['includes b'], p2p: ['sums a..b-1'], fix: { 'src/a.ts': 'export const x = 1;\n' } },
    adequacy: { file: 'src/a.ts', delete: 'const x = 1;' },
    tell_audit: { critic: 'muse-spark reviewer', verdict: 'not-told' },
  };

  it('parses and catalog-checks a valid record', () => {
    const record = parseFaultRecord(JSON.stringify(validRecord), 'valid');
    expect(record.operator).toBe('equality-boundary');
    expect(record.difficulty).toBe('easy');
  });

  it('rejects a trivial-prone operator outside the easy tier', () => {
    const bad = { ...validRecord, operator: 'constant-delta', difficulty: 'medium' };
    expect(() => parseFaultRecord(JSON.stringify(bad), 'bad-band')).toThrow(/trivial-prone/);
  });

  it('rejects an unknown operator and a fix outside src/', () => {
    expect(() => parseFaultRecord(JSON.stringify({ ...validRecord, operator: 'not-real' }), 'bad-op')).toThrow(/unknown operator/);
    const badFix = { ...validRecord, validation: { ...validRecord.validation, fix: { 'test/a.ts': 'x' } } };
    expect(() => parseFaultRecord(JSON.stringify(badFix), 'bad-fix')).toThrow(/failed fault.schema.json validation/);
  });

  it('rejects a fix path with traversal segments', () => {
    const bad = { ...validRecord, validation: { ...validRecord.validation, fix: { 'src/../../outside.ts': 'x' } } };
    expect(() => parseFaultRecord(JSON.stringify(bad), 'bad-traversal')).toThrow(/failed fault.schema.json validation/);
  });

  it('derives the sibling record path outside the materialized fixture dir', () => {
    expect(faultRecordRelPath('fixtures/breadth-01')).toBe('fixtures/breadth-01.FAULT.json');
    expect(faultRecordRelPath('fixtures/breadth-01/')).toBe('fixtures/breadth-01.FAULT.json');
  });
});
