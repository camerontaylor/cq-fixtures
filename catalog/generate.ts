// Engine adapters for the operator catalog (plan WB-2.2). Both engines are
// devDependencies and are MUTANT GENERATORS ONLY — the repo's judge remains
// the scorer (R6 digest §1). Nothing here runs in a worker workspace or on the
// scoring path.
//
//   * `@stryker-mutator/instrumenter` (Apache-2.0) drives the 19 transferred
//     operators through its Babel AST + NodeMutator maps. Its `instrument()`
//     returns the mutants it found (replacement + zero-based line/column
//     location); we convert locations to character offsets so callers can
//     splice one mutant into a source string.
//   * `ts-morph` (MIT) drives the 5 TS-specific operators (shared-reference
//     return, Promise.all → unawaited elements, default-param removal,
//     non-null overreach, radix/coercion drop), which StrykerJS does not
//     provide.
//
// The generator direction is always clean → faulted: an operator is applied to
// a green substrate to seed a fault.

import { Instrumenter } from '@stryker-mutator/instrumenter';
import type { Logger } from '@stryker-mutator/api/logging';
import { Project, SyntaxKind, type CallExpression, type Node, type SourceFile } from 'ts-morph';
import { OPERATORS, operatorById, type OperatorSpec } from './operators.ts';
import { BABEL_TRANSFORMS } from './babel-transforms.ts';

/** One candidate fault: a source span and the text that replaces it. */
export interface GeneratedMutant {
  readonly operatorId: string;
  readonly fileName: string;
  /** Character offset of the first replaced character in the input source. */
  readonly start: number;
  /** Character offset one past the last replaced character. */
  readonly end: number;
  readonly original: string;
  readonly replacement: string;
  readonly note: string;
}

/** Apply one generated mutant to its source, returning the faulted text. */
export function applyMutant(source: string, mutant: GeneratedMutant): string {
  return source.slice(0, mutant.start) + mutant.replacement + source.slice(mutant.end);
}

/** Stryker mutator name → the catalog operators it can seed. Operators with
 * an authored Babel transform are excluded: the authored transform is
 * canonical for them, so `generateBabelMutants` never claims their mutants. */
const OPERATORS_BY_STRYKER_MUTATOR: ReadonlyMap<string, readonly OperatorSpec[]> = (() => {
  const map = new Map<string, OperatorSpec[]>();
  for (const op of OPERATORS) {
    if (BABEL_TRANSFORMS[op.id] !== undefined) continue;
    for (const name of op.strykerMutators) {
      const list = map.get(name);
      if (list === undefined) map.set(name, [op]);
      else list.push(op);
    }
  }
  return map;
})();

/** Every StrykerJS NodeMutator name the catalog draws from. */
export function catalogStrykerMutators(): readonly string[] {
  return [...OPERATORS_BY_STRYKER_MUTATOR.keys()].sort();
}

/** Minimal Logger satisfying the instrumenter's interface without touching stdout. */
const SILENT_LOGGER: Logger = {
  isTraceEnabled: () => false,
  isDebugEnabled: () => false,
  isInfoEnabled: () => false,
  isWarnEnabled: () => false,
  isErrorEnabled: () => false,
  isFatalEnabled: () => false,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
};

/** Zero-based line/column → character offset in `source`. */
function offsetAt(source: string, line: number, column: number): number {
  let offset = 0;
  for (let l = 0; l < line; l++) {
    const nl = source.indexOf('\n', offset);
    if (nl === -1) return source.length;
    offset = nl + 1;
  }
  return Math.min(offset + column, source.length);
}

export interface GenerateOptions {
  /** Restrict output to one catalog operator (default: every babel operator). */
  readonly operatorId?: string;
}

/**
 * Generate Babel-engine candidate faults with StrykerJS's instrumenter.
 * TypeScript sources parse through StrykerJS's own `@babel/preset-typescript`
 * path, so a `.ts` file name is enough — no extra Babel plugins are needed.
 * `plugins: null` is the JS-parser plugin list; TS files ignore it.
 */
export async function generateBabelMutants(
  source: string,
  fileName: string,
  options: GenerateOptions = {},
): Promise<GeneratedMutant[]> {
  const instrumenter = new Instrumenter(SILENT_LOGGER);
  const result = await instrumenter.instrument(
    [{ name: fileName, content: source, mutate: true }],
    { plugins: null, excludedMutations: [], ignorers: [] },
  );
  const out: GeneratedMutant[] = [];
  for (const mutant of result.mutants) {
    const operators = OPERATORS_BY_STRYKER_MUTATOR.get(mutant.mutatorName) ?? [];
    for (const op of operators) {
      if (options.operatorId !== undefined && op.id !== options.operatorId) continue;
      const start = offsetAt(source, mutant.location.start.line, mutant.location.start.column);
      const end = offsetAt(source, mutant.location.end.line, mutant.location.end.column);
      out.push({
        operatorId: op.id,
        fileName,
        start,
        end,
        original: source.slice(start, end),
        replacement: mutant.replacement,
        note: `stryker:${mutant.mutatorName}`,
      });
    }
  }
  return out;
}

// --- ts-morph operators -----------------------------------------------------

function projectFor(source: string, fileName: string): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile(fileName, source);
}

function mutantFromNode(operatorId: string, fileName: string, node: Node, replacement: string, note: string): GeneratedMutant {
  const start = node.getStart();
  const end = node.getEnd();
  return {
    operatorId,
    fileName,
    start,
    end,
    original: node.getText(),
    replacement,
    note,
  };
}

/** `[...xs]` → `xs`; `structuredClone(x)` → `x` (drop the defensive copy). */
function sharedReferenceReturn(sf: SourceFile, fileName: string): GeneratedMutant[] {
  const out: GeneratedMutant[] = [];
  for (const array of sf.getDescendantsOfKind(SyntaxKind.ArrayLiteralExpression)) {
    const elements = array.getElements();
    if (elements.length !== 1 || elements[0]!.getKind() !== SyntaxKind.SpreadElement) continue;
    const spread = elements[0]!;
    const inner = spread.getText().replace(/^\.\.\./, '');
    out.push(mutantFromNode('shared-reference-return', fileName, array, inner, 'drop array spread (return live reference)'));
  }
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getText() !== 'structuredClone') continue;
    const arg = call.getArguments()[0];
    if (arg === undefined) continue;
    out.push(mutantFromNode('shared-reference-return', fileName, call, arg.getText(), 'drop structuredClone (return live reference)'));
  }
  return out;
}

/** `await Promise.all(xs.map(f))` → `await (xs.map(f))` (elements never awaited). */
function promiseAllSequential(sf: SourceFile, fileName: string): GeneratedMutant[] {
  const out: GeneratedMutant[] = [];
  for (const awaited of sf.getDescendantsOfKind(SyntaxKind.AwaitExpression)) {
    const expression = awaited.getExpression();
    if (expression.getKind() !== SyntaxKind.CallExpression) continue;
    const call = expression as CallExpression;
    if (!/^Promise\s*\.\s*all$/.test(call.getExpression().getText())) continue;
    const arg = call.getArguments()[0];
    if (arg === undefined) continue;
    out.push(mutantFromNode('promise-all-sequential', fileName, call, `(${arg.getText()})`, 'drop Promise.all (await the array, not its elements)'));
  }
  return out;
}

/** `function f(x = 1)` → `function f(x)` (default removed, undefined leaks in). */
function defaultParamRemoval(sf: SourceFile, fileName: string): GeneratedMutant[] {
  const out: GeneratedMutant[] = [];
  for (const fn of [
    ...sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
    ...sf.getDescendantsOfKind(SyntaxKind.FunctionExpression),
    ...sf.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...sf.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
  ]) {
    for (const param of fn.getParameters()) {
      const initializer = param.getInitializer();
      if (initializer === undefined) continue;
      // Preserve the name AND type annotation; drop only the `= <default>`
      // tail, so `x: number = 1` becomes `x: number` (not a bare `x`).
      const text = param.getText();
      const cut = initializer.getStart() - param.getStart();
      const replacement = text.slice(0, cut).replace(/=\s*$/, '').trimEnd();
      out.push(mutantFromNode('default-param-removal', fileName, param, replacement, 'remove parameter default'));
    }
  }
  return out;
}

/** `a?.b` → `a!.b`; `a?.[i]` → `a![i]` (assert non-null where optional was safe). */
function nonNullOverreach(sf: SourceFile, fileName: string): GeneratedMutant[] {
  const out: GeneratedMutant[] = [];
  for (const node of [
    ...sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression),
    ...sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression),
  ]) {
    const text = node.getText();
    if (!text.includes('?.')) continue;
    // Element access `a?.[i]` must become `a![i]`, not `a!.[i]`; the
    // property-access replacement then handles `a?.b` -> `a!.b`.
    const replacement = text.replace('?.[', '![').replace('?.', '!.');
    out.push(mutantFromNode('non-null-overreach', fileName, node, replacement, 'replace optional access with non-null assertion'));
  }
  return out;
}

/** `parseInt(x, 10)` → `parseInt(x)`; `Number(x)` → `+x`. */
function radixCoercionDrop(sf: SourceFile, fileName: string): GeneratedMutant[] {
  const out: GeneratedMutant[] = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression().getText();
    if (callee === 'parseInt' && call.getArguments().length >= 2) {
      const first = call.getArguments()[0]!;
      out.push(mutantFromNode('radix-coercion-drop', fileName, call, `parseInt(${first.getText()})`, 'drop parseInt radix'));
    } else if (callee === 'Number' && call.getArguments().length === 1) {
      out.push(mutantFromNode('radix-coercion-drop', fileName, call, `+${call.getArguments()[0]!.getText()}`, 'replace Number() with unary +'));
    }
  }
  return out;
}

const TS_MORPH_OPERATORS: Record<string, (sf: SourceFile, fileName: string) => GeneratedMutant[]> = {
  'shared-reference-return': sharedReferenceReturn,
  'promise-all-sequential': promiseAllSequential,
  'default-param-removal': defaultParamRemoval,
  'non-null-overreach': nonNullOverreach,
  'radix-coercion-drop': radixCoercionDrop,
};

/** The TS-specific operator ids this engine provides. */
export function tsMorphOperatorIds(): readonly string[] {
  return Object.keys(TS_MORPH_OPERATORS);
}

/** Generate candidate faults for one TS-specific operator. */
export function generateTsMorphMutants(source: string, fileName: string, operatorId: string): GeneratedMutant[] {
  const fn = TS_MORPH_OPERATORS[operatorId];
  if (fn === undefined) {
    throw new Error(`operator '${operatorId}' is not a ts-morph operator (known: ${tsMorphOperatorIds().join(', ')})`);
  }
  return fn(projectFor(source, fileName), fileName);
}

/** Dispatch to the engine named by the operator's catalog entry. */
export async function generateForOperator(source: string, fileName: string, operatorId: string): Promise<GeneratedMutant[]> {
  const op = operatorById(operatorId);
  if (op === undefined) throw new Error(`unknown operator '${operatorId}'`);
  if (op.engine === 'ts-morph') return generateTsMorphMutants(source, fileName, operatorId);
  const authored = BABEL_TRANSFORMS[operatorId];
  if (authored !== undefined) return authored(source, fileName);
  return generateBabelMutants(source, fileName, { operatorId });
}
