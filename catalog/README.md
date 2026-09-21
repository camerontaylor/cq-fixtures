# Operator catalog

Dev-only mutant generators for the breadth fixtures (plan WB-2.2). Nothing in
this directory runs on the scoring path or ships into a worker workspace — the
repo's judge is the scorer; the engines here only GENERATE candidate faults
(R6 digest §1).

- `operators.ts` — the 24-operator v1 catalog: id, engine, `bug_type`,
  difficulty bands, `trivialProne`, StrykerJS mutator names, source, and
  description. Pure data + predicates (`operatorsForBand`,
  `discriminationEligible`, `checkOperatorAssignment`). `trivial-prone`
  operators (constant ±1, remove loop, empty block/arrow→undefined) are
  restricted to the easy tier and excluded from discrimination scoring.
- `generate.ts` — engine adapters. StrykerJS `@stryker-mutator/instrumenter`
  drives 9 of the 19 transferred Babel-side operators; the authored transforms
  in `babel-transforms.ts` drive the other 10; `ts-morph` drives the 5
  TS-specific ones (shared-reference return, Promise.all → unawaited elements,
  default-param removal, non-null overreach, radix/coercion drop). Both engines
  are devDependencies.
- `babel-transforms.ts` — authored Babel transforms for the SWE-smith-derived
  operators StrykerJS does not provide (constant ±1, operand swap, chain break,
  argument swap, if/else invert, statement shuffle, remove loop/conditional/
  assignment). SWE-smith itself is a strategy reference only — no code is
  vendored.
- `fault.ts` — loads and validates the fixture-side `FAULT.json` record
  (`schema/fault.schema.json`) and applies its canonical fix. The record lives
  at `fixtures/<name>.FAULT.json`, OUTSIDE the materialized fixture directory.
- `substrates/` — six clean, zero-dependency multi-module TypeScript packages
  (`textkit`, `ledger`, `schedule`, `graph`, `validate`, `queue`) used as the
  generation substrates for the F3 tail. They are typechecked by the repo's
  `tsc` but excluded from `npm test` (`vitest.config.ts`).
- `recipes.ts` + `generate-cases.ts` — the deterministic case generator: each
  recipe names a substrate and its mutation(s); `--write` materializes
  `fixtures/breadth-11..40` + their `FAULT.json`, and `--check` proves the
  committed corpus still matches the recipes (CI).
- `pipeline.ts` — the runnable validation-filter chain (R6 digest §2): the
  static annotation gate, the reachability gate, the F2P gate, the 100%-green
  baseline, determinism ×3 both states, the per-title JSON check, the
  single-statement-deletion adequacy gate, and the format/tell pass. Run it as
  `node --experimental-strip-types catalog/pipeline.ts --suite <dir> [--full]`;
  `test/breadth.test.ts` drives it for both breadth suites (both-states for
  the tail, full chain for the verified tier).

## License posture

| Engine | License | Use |
| --- | --- | --- |
| `@stryker-mutator/instrumenter` | Apache-2.0 | mutant generation |
| `ts-morph` | MIT | TS-specific operators |
| `@babel/parser` / `@babel/types` | MIT | authored transforms |
| SWE-smith | MIT | strategy reference only — no code vendored |

## Using the catalog

```ts
import { operatorsForBand, discriminationEligible } from './catalog/operators.ts';
import { generateForOperator, applyMutant } from './catalog/generate.ts';

const mutants = await generateForOperator(source, 'src/thing.ts', 'arithmetic-swap');
const faulted = applyMutant(source, mutants[0]!);
```

Validation of a candidate (does it compile, flip a test, stay deterministic,
survive the adequacy/tell gates) is the pipeline's job (plan WB-2.3, F3). This
directory only enumerates and applies operators.
