// The judge's explicit vitest config (fresh-reviewer round 1, PR 10): the
// shared judge (fixtures/judge-lib.mjs) spawns vitest with --config pointing
// HERE, and naming a config disables vitest's config discovery entirely —
// so a worker-planted vitest.config.* / vite.config.* in the workspace copy
// is inert even if the scrub ever missed one. Deliberately minimal: the
// workspace root (passed via --root) supplies the tests; defaults govern
// discovery WITHIN that root.
export default { test: { environment: 'node' } };
