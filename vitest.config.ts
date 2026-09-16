import { defaultExclude, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // The micro fixtures' test/*.test.ts suites are SEEDED-FAULT suites: they
    // must FAIL on the pristine fixture — that failing state is the judge's
    // discrimination baseline (fixtures/micro-*/check.mjs), and they are
    // graded inside per-case materialized workspace copies by
    // test/micro.test.ts. Excluded from the repo's own `npm test`: a root
    // run over them would be red by design, and the repo's gates must stay
    // green while its fixtures are intentionally broken.
    exclude: [...defaultExclude, 'fixtures/**'],
  },
});
