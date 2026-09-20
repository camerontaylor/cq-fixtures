// Authored Babel transforms for the SWE-smith-derived operators that
// StrykerJS's NodeMutator set does not provide (R6 digest §7 rows 8, 9, 11–16).
// SWE-smith itself is a STRATEGY reference only — no code is vendored (its JS
// modifiers carry documented KNOWN-ISSUES; digest §1). These transforms
// re-implement the operator SEMANTICS on `@babel/parser`'s AST (MIT), the same
// Babel AST StrykerJS uses, so operator behavior matches the digest's catalog.
//
// Each transform is a candidate GENERATOR: it finds every applicable node and
// returns the faulted text. Applicability/validation (does the mutant compile,
// flip a test, stay deterministic) is the pipeline's job (plan WB-2.3, F3).

import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import type { GeneratedMutant } from './generate.ts';

type Transform = (source: string, fileName: string) => GeneratedMutant[];

interface Span {
  start: number;
  end: number;
  text: string;
}

function span(source: string, node: Node): Span {
  const start = node.start ?? 0;
  const end = node.end ?? start;
  return { start, end, text: source.slice(start, end) };
}

function makeMutant(operatorId: string, fileName: string, s: Span, replacement: string, note: string): GeneratedMutant {
  return { operatorId, fileName, start: s.start, end: s.end, original: s.text, replacement, note };
}

/**
 * Swap two non-overlapping spans inside an outer span, offset-based so a
 * repeated token can never be swapped in the wrong place (the `String.replace`
 * approach would hit the first textual occurrence, not the intended node).
 */
function swapSpans(source: string, outer: Span, a: Span, b: Span): string {
  const [first, second] = a.start <= b.start ? [a, b] : [b, a];
  const rel = (n: number): number => n - outer.start;
  return (
    outer.text.slice(0, rel(first.start)) +
    outer.text.slice(rel(second.start), rel(second.end)) +
    outer.text.slice(rel(first.end), rel(second.start)) +
    outer.text.slice(rel(first.start), rel(first.end)) +
    outer.text.slice(rel(second.end))
  );
}

/** Depth-first walk over every Babel AST node (comments excluded). */
function walk(node: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if (typeof record.type === 'string' && typeof record.start === 'number' && typeof record.end === 'number') {
    visit(node as Node);
  }
  for (const key of Object.keys(record)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    walk(record[key], visit);
  }
}

function parseModule(source: string): Node {
  return parse(source, { sourceType: 'module', plugins: ['typescript'] }).program;
}

const NON_COMMUTATIVE = new Set(['-', '/', '%', '**', '<<', '>>', '>>>']);

/** constant ±1 / literal change (digest row 8; trivial-prone, easy tier only). */
const constantDelta: Transform = (source, fileName) => {
  const out: GeneratedMutant[] = [];
  walk(parseModule(source), (node) => {
    if (node.type === 'NumericLiteral' && Number.isInteger((node as { value: number }).value)) {
      const value = (node as { value: number }).value;
      out.push(makeMutant('constant-delta', fileName, span(source, node), String(value + 1), 'numeric literal +1'));
    } else if (node.type === 'BooleanLiteral') {
      const value = (node as { value: boolean }).value;
      out.push(makeMutant('constant-delta', fileName, span(source, node), String(!value), 'boolean literal flip'));
    }
  });
  return out;
};

/** operand swap a-b → b-a (digest row 7 lives on ts-morph; this is the babel-safe fallback for other non-commutative forms). */
const operandSwap: Transform = (source, fileName) => {
  const out: GeneratedMutant[] = [];
  walk(parseModule(source), (node) => {
    if (node.type !== 'BinaryExpression') return;
    const expr = node as unknown as { operator: string; left: Node; right: Node };
    if (!NON_COMMUTATIVE.has(expr.operator)) return;
    const s = span(source, node);
    out.push(makeMutant('operand-swap', fileName, s, `${span(source, expr.right).text} ${expr.operator} ${span(source, expr.left).text}`, 'swap binary operands'));
  });
  return out;
};

/** chained-expression break: drop the last link of a 2+ method chain (digest row 9). */
const chainBreak: Transform = (source, fileName) => {
  const out: GeneratedMutant[] = [];
  walk(parseModule(source), (node) => {
    if (node.type !== 'CallExpression') return;
    const call = node as unknown as { callee: Node };
    if (call.callee.type !== 'MemberExpression' && call.callee.type !== 'OptionalMemberExpression') return;
    const member = call.callee as unknown as { object: Node };
    if (member.object.type !== 'CallExpression') return;
    const s = span(source, node);
    out.push(makeMutant('chain-break', fileName, s, span(source, member.object).text, 'drop the last method-chain link'));
  });
  return out;
};

/** function-argument order swap (digest row 11). */
const argumentSwap: Transform = (source, fileName) => {
  const out: GeneratedMutant[] = [];
  walk(parseModule(source), (node) => {
    if (node.type !== 'CallExpression') return;
    const args = (node as unknown as { arguments: Node[] }).arguments;
    if (args.length < 2) return;
    const first = span(source, args[0]!);
    const second = span(source, args[1]!);
    const s = span(source, node);
    out.push(makeMutant('argument-swap', fileName, s, swapSpans(source, s, first, second), 'swap the first two call arguments'));
  });
  return out;
};

/** invert if/else bodies (digest row 12). */
const ifElseInvert: Transform = (source, fileName) => {
  const out: GeneratedMutant[] = [];
  walk(parseModule(source), (node) => {
    if (node.type !== 'IfStatement') return;
    const stmt = node as unknown as { consequent: Node; alternate: Node | null };
    if (stmt.alternate === null || stmt.alternate === undefined) return;
    const consequent = span(source, stmt.consequent);
    const alternate = span(source, stmt.alternate);
    const s = span(source, node);
    out.push(makeMutant('if-else-invert', fileName, s, swapSpans(source, s, consequent, alternate), 'swap consequent and alternate'));
  });
  return out;
};

/** shuffle two adjacent independent statements (digest row 13). */
const statementShuffle: Transform = (source, fileName) => {
  const out: GeneratedMutant[] = [];
  walk(parseModule(source), (node) => {
    if (node.type !== 'BlockStatement') return;
    const body = (node as unknown as { body: Node[] }).body;
    if (body.length < 2) return;
    const first = span(source, body[0]!);
    const second = span(source, body[1]!);
    const s = span(source, node);
    out.push(makeMutant('statement-shuffle', fileName, s, swapSpans(source, s, first, second), 'swap the first two statements'));
  });
  return out;
};

/** remove loop (digest row 14; trivial-prone, easy tier only). */
const removeLoop: Transform = (source, fileName) => {
  const out: GeneratedMutant[] = [];
  walk(parseModule(source), (node) => {
    if (node.type !== 'ForStatement' && node.type !== 'WhileStatement' && node.type !== 'DoWhileStatement') return;
    out.push(makeMutant('remove-loop', fileName, span(source, node), '', 'remove the loop entirely'));
  });
  return out;
};

/** remove conditional: unwrap an if with no else (digest row 15). */
const removeConditional: Transform = (source, fileName) => {
  const out: GeneratedMutant[] = [];
  walk(parseModule(source), (node) => {
    if (node.type !== 'IfStatement') return;
    const stmt = node as unknown as { alternate: Node | null; consequent: Node };
    if (stmt.alternate !== null && stmt.alternate !== undefined) return;
    out.push(makeMutant('remove-conditional', fileName, span(source, node), span(source, stmt.consequent).text, 'drop the guard, keep the body'));
  });
  return out;
};

/** remove assignment (drop a state write; digest row 16). */
const removeAssignment: Transform = (source, fileName) => {
  const out: GeneratedMutant[] = [];
  walk(parseModule(source), (node) => {
    if (node.type !== 'ExpressionStatement') return;
    const expression = (node as unknown as { expression: Node }).expression;
    if (expression.type !== 'AssignmentExpression') return;
    if ((expression as unknown as { operator: string }).operator !== '=') return;
    out.push(makeMutant('remove-assignment', fileName, span(source, node), '', 'remove the assignment statement'));
  });
  return out;
};

/**
 * The authored Babel transform registry, keyed by catalog operator id. An
 * operator with a StrykerJS mutator is generated by the instrumenter instead
 * (see generate.ts); this registry covers only the SWE-smith-derived ones.
 */
export const BABEL_TRANSFORMS: Readonly<Record<string, Transform>> = {
  'constant-delta': constantDelta,
  'operand-swap': operandSwap,
  'chain-break': chainBreak,
  'argument-swap': argumentSwap,
  'if-else-invert': ifElseInvert,
  'statement-shuffle': statementShuffle,
  'remove-loop': removeLoop,
  'remove-conditional': removeConditional,
  'remove-assignment': removeAssignment,
};
