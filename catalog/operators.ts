// Operator catalog — the mutant-generator vocabulary the breadth fixtures are
// seeded from (plan WB-2.2; R6 digest §7). This module is DATA + pure
// predicates only: the engine adapters that actually produce mutants live in
// `./generate.ts`, and the engines themselves (`@stryker-mutator/instrumenter`,
// `ts-morph`) are devDependencies — the catalog never ships in a worker
// workspace and never participates in scoring. The repo's judge stays the
// scorer; StrykerJS/ts-morph are mutant GENERATORS only (R6 digest §1).
//
// License posture (R6 digest §5): StrykerJS `@stryker-mutator/*` is
// Apache-2.0, `ts-morph` is MIT, Babel is MIT. SWE-smith is MIT but is used as
// a STRATEGY reference only — no code is vendored from it (its JS modifier
// list carries documented KNOWN-ISSUES; digest §1). Each entry below names its
// source so a reader can tell transferred operators from authored ones.

/**
 * The HumanEvalFix `bug_type` enum (R6 digest §5: the enum is copied from the
 * MIT-licensed HumanEvalPack dataset; no instances are vendored).
 */
export type BugType =
  | 'missing logic'
  | 'operator misuse'
  | 'variable misuse'
  | 'value misuse'
  | 'excess logic'
  | 'function misuse';

/** The three difficulty tiers (plan WB-2.4: 16 easy / 16 medium / 8 hard). */
export type DifficultyBand = 'easy' | 'medium' | 'hard';

/** Which generator engine applies the operator. */
export type Engine = 'babel' | 'ts-morph';

/** Where the operator came from. */
export type OperatorSource = 'stryker' | 'swe-smith' | 'author';

export interface OperatorSpec {
  /** Stable kebab-case id used by FAULT.json `operator` and the generators. */
  readonly id: string;
  /** Human title. */
  readonly title: string;
  readonly engine: Engine;
  readonly bugType: BugType;
  /**
   * Difficulty tiers the operator may seed. A `trivialProne` operator is
   * restricted to `['easy']` (plan WB-2.2) and is excluded from discrimination
   * scoring — a constant ±1 or an emptied block is obvious enough that it
   * measures attention, not diagnosis.
   */
  readonly bands: readonly DifficultyBand[];
  /** True for the digest §7 trivial-prone class (constant ±1, remove loop, empty block/arrow→undefined). */
  readonly trivialProne: boolean;
  /** StrykerJS NodeMutator `name` values this operator is generated from (babel engine). */
  readonly strykerMutators: readonly string[];
  readonly source: OperatorSource;
  readonly description: string;
}

/**
 * The v1 catalog (R6 digest §7, rows 1–24). Rows 1–19 transfer from the
 * verified SWE-smith JS/TS modifier list + StrykerJS NodeMutator maps; rows
 * 20–24 are the TS-specific additions authored for this repo. The digest lists
 * ~18; the plan's WB-2.2 settles on ~24, and every row is kept here.
 */
export const OPERATORS: readonly OperatorSpec[] = [
  {
    id: 'arithmetic-swap',
    title: 'arithmetic operator swap (+↔- *↔/)',
    engine: 'babel',
    bugType: 'operator misuse',
    bands: ['easy', 'medium', 'hard'],
    trivialProne: false,
    strykerMutators: ['ArithmeticOperator'],
    source: 'stryker',
    description: 'Swaps an arithmetic operator for another one in its StrykerJS map.',
  },
  {
    id: 'assignment-swap',
    title: 'augmented-assignment swap (+=↔-=)',
    engine: 'babel',
    bugType: 'operator misuse',
    bands: ['easy', 'medium', 'hard'],
    trivialProne: false,
    strykerMutators: ['AssignmentOperator'],
    source: 'stryker',
    description: 'Swaps a compound assignment operator (e.g. += to -=).',
  },
  {
    id: 'equality-boundary',
    title: 'equality boundary shift (>=↔>)',
    engine: 'babel',
    bugType: 'operator misuse',
    bands: ['easy', 'medium', 'hard'],
    trivialProne: false,
    strykerMutators: ['EqualityOperator'],
    source: 'stryker',
    description: 'Shifts a relational/equality operator across its StrykerJS boundary map.',
  },
  {
    id: 'logical-swap',
    title: 'logical operator swap (&&↔||, ??→&&)',
    engine: 'babel',
    bugType: 'operator misuse',
    bands: ['easy', 'medium', 'hard'],
    trivialProne: false,
    strykerMutators: ['LogicalOperator'],
    source: 'stryker',
    description: 'Swaps a logical operator.',
  },
  {
    id: 'unary-flip',
    title: 'unary negation flip',
    engine: 'babel',
    bugType: 'operator misuse',
    bands: ['easy', 'medium', 'hard'],
    trivialProne: false,
    strykerMutators: ['UnaryOperator'],
    source: 'stryker',
    description: 'Flips a unary operator (e.g. -x to +x, !x to x).',
  },
  {
    id: 'update-flip',
    title: 'update operator flip (++↔--)',
    engine: 'babel',
    bugType: 'operator misuse',
    bands: ['easy', 'medium', 'hard'],
    trivialProne: false,
    strykerMutators: ['UpdateOperator'],
    source: 'stryker',
    description: 'Flips a prefix/postfix increment to a decrement (or back).',
  },
  {
    id: 'operand-swap',
    title: 'operand swap (a-b → b-a)',
    engine: 'babel',
    bugType: 'variable misuse',
    bands: ['easy', 'medium', 'hard'],
    trivialProne: false,
    strykerMutators: [],
    source: 'swe-smith',
    description: 'Swaps the two operands of a non-commutative binary expression.',
  },
  {
    id: 'constant-delta',
    title: 'constant ±1 / literal change',
    engine: 'babel',
    bugType: 'value misuse',
    bands: ['easy'],
    trivialProne: true,
    strykerMutators: [],
    source: 'swe-smith',
    description: 'Shifts a numeric literal by ±1 or flips a boolean literal (trivial-prone: easy tier only). Implemented by the authored Babel transform in babel-transforms.ts.',
  },
  {
    id: 'chain-break',
    title: 'chained-expression break',
    engine: 'babel',
    bugType: 'operator misuse',
    bands: ['medium', 'hard'],
    trivialProne: false,
    strykerMutators: [],
    source: 'swe-smith',
    description: 'Breaks a method chain, dropping the effect of a later link (authored Babel transform).',
  },
  {
    id: 'ternary-swap',
    title: 'ternary branch swap',
    engine: 'babel',
    bugType: 'operator misuse',
    bands: ['easy', 'medium', 'hard'],
    trivialProne: false,
    strykerMutators: ['ConditionalExpression'],
    source: 'swe-smith',
    description: 'Swaps the consequent/alternate arms of a conditional expression.',
  },
  {
    id: 'argument-swap',
    title: 'function-argument order swap',
    engine: 'babel',
    bugType: 'variable misuse',
    bands: ['easy', 'medium', 'hard'],
    trivialProne: false,
    strykerMutators: [],
    source: 'swe-smith',
    description: 'Swaps two arguments at a call site.',
  },
  {
    id: 'if-else-invert',
    title: 'invert if/else bodies',
    engine: 'babel',
    bugType: 'excess logic',
    bands: ['easy', 'medium', 'hard'],
    trivialProne: false,
    strykerMutators: [],
    source: 'swe-smith',
    description: 'Swaps the consequent and alternate blocks of an if statement (authored Babel transform).',
  },
  {
    id: 'statement-shuffle',
    title: 'shuffle independent statements',
    engine: 'babel',
    bugType: 'variable misuse',
    bands: ['medium', 'hard'],
    trivialProne: false,
    strykerMutators: [],
    source: 'swe-smith',
    description: 'Reorders two adjacent independent statements, breaking a dependency.',
  },
  {
    id: 'remove-loop',
    title: 'remove loop',
    engine: 'babel',
    bugType: 'missing logic',
    bands: ['easy'],
    trivialProne: true,
    strykerMutators: [],
    source: 'swe-smith',
    description: 'Removes a loop body (trivial-prone: easy tier only).',
  },
  {
    id: 'remove-conditional',
    title: 'remove conditional',
    engine: 'babel',
    bugType: 'excess logic',
    bands: ['easy', 'medium', 'hard'],
    trivialProne: false,
    strykerMutators: [],
    source: 'swe-smith',
    description: 'Removes an if guard so the guarded branch always runs.',
  },
  {
    id: 'remove-assignment',
    title: 'remove assignment (drop cache write)',
    engine: 'babel',
    bugType: 'missing logic',
    bands: ['easy', 'medium', 'hard'],
    trivialProne: false,
    strykerMutators: [],
    source: 'swe-smith',
    description: 'Removes an assignment that carries state to a later read.',
  },
  {
    id: 'empty-block',
    title: 'arrow → undefined / empty block',
    engine: 'babel',
    bugType: 'missing logic',
    bands: ['easy'],
    trivialProne: true,
    strykerMutators: ['BlockStatement', 'ArrowFunction'],
    source: 'stryker',
    description: 'Empties a function body or block (trivial-prone: easy tier only).',
  },
  {
    id: 'optional-chaining-removal',
    title: 'optional-chaining removal (a?.b → a.b)',
    engine: 'babel',
    bugType: 'function misuse',
    bands: ['easy', 'medium', 'hard'],
    trivialProne: false,
    strykerMutators: ['OptionalChaining'],
    source: 'stryker',
    description: 'Drops optional chaining so a nullish receiver throws.',
  },
  {
    id: 'method-swap',
    title: 'method swap (filter↔map/some/every)',
    engine: 'babel',
    bugType: 'function misuse',
    bands: ['easy', 'medium', 'hard'],
    trivialProne: false,
    strykerMutators: ['MethodExpression'],
    source: 'swe-smith',
    description: 'Swaps an array method for a sibling with different semantics.',
  },
  {
    id: 'shared-reference-return',
    title: 'shared-reference return (drop [...]/structuredClone)',
    engine: 'ts-morph',
    bugType: 'variable misuse',
    bands: ['medium', 'hard'],
    trivialProne: false,
    strykerMutators: [],
    source: 'author',
    description: 'Returns a live internal reference instead of a copy.',
  },
  {
    id: 'promise-all-sequential',
    title: 'Promise.all → unawaited element promises',
    engine: 'ts-morph',
    bugType: 'function misuse',
    bands: ['medium', 'hard'],
    trivialProne: false,
    strykerMutators: [],
    source: 'author',
    description: 'Drops Promise.all so awaiting the collection no longer awaits its elements.',
  },
  {
    id: 'default-param-removal',
    title: 'default-param removal / optional widening',
    engine: 'ts-morph',
    bugType: 'value misuse',
    bands: ['medium', 'hard'],
    trivialProne: false,
    strykerMutators: [],
    source: 'author',
    description: 'Removes a parameter default, letting undefined leak into the body.',
  },
  {
    id: 'non-null-overreach',
    title: 'non-null assertion overreach',
    engine: 'ts-morph',
    bugType: 'function misuse',
    bands: ['medium', 'hard'],
    trivialProne: false,
    strykerMutators: [],
    source: 'author',
    description: 'Replaces a safe optional access with a non-null assertion that can throw.',
  },
  {
    id: 'radix-coercion-drop',
    title: 'radix/coercion drop (parseInt(x) without radix, Number → +)',
    engine: 'ts-morph',
    bugType: 'value misuse',
    bands: ['medium', 'hard'],
    trivialProne: false,
    strykerMutators: [],
    source: 'author',
    description: 'Drops a radix or coercion that made parsing unambiguous.',
  },
];

const BY_ID = new Map(OPERATORS.map((op) => [op.id, op] as const));

export function operatorById(id: string): OperatorSpec | undefined {
  return BY_ID.get(id);
}

/** The trivial-prone class (digest §7): easy tier only, never discrimination-scored. */
export function trivialProneOperators(): readonly OperatorSpec[] {
  return OPERATORS.filter((op) => op.trivialProne);
}

/**
 * Operators usable at a difficulty band. Trivial-prone operators are
 * restricted to `easy` (plan WB-2.2) — asking for `medium`/`hard` never
 * returns one.
 */
export function operatorsForBand(band: DifficultyBand): readonly OperatorSpec[] {
  return OPERATORS.filter((op) => op.bands.includes(band));
}

/**
 * Whether an operator may contribute to a discrimination score. Trivial-prone
 * operators are excluded (plan WB-2.2): they stay in the corpus for tier
 * coverage but must not be read as diagnostic signal.
 */
export function discriminationEligible(op: OperatorSpec): boolean {
  return !op.trivialProne;
}

/**
 * Check one (operator, band) assignment against the catalog's rules. Returns a
 * reason string on rejection so callers can fail loudly with the mechanism.
 */
export function checkOperatorAssignment(operatorId: string, band: DifficultyBand): { ok: true } | { ok: false; reason: string } {
  const op = operatorById(operatorId);
  if (op === undefined) return { ok: false, reason: `unknown operator '${operatorId}'` };
  if (!op.bands.includes(band)) {
    return {
      ok: false,
      reason:
        op.trivialProne && band !== 'easy'
          ? `trivial-prone operator '${op.id}' is restricted to the easy tier (requested '${band}')`
          : `operator '${op.id}' is not registered for the '${band}' tier`,
    };
  }
  return { ok: true };
}
