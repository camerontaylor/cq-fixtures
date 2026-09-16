// The judge's explicit vitest config (fresh-reviewer round 1, PR 10; pinned
// round 2): the shared judge (fixtures/judge-lib.mjs) spawns vitest with
// --config pointing HERE, and naming a config disables vitest's config
// discovery entirely — so a worker-planted vitest.config.* / vite.config.*
// in the workspace copy is inert even if the scrub ever missed one. The
// discovery surface is pinned explicitly: include globs resolve against the
// --root workspace, so this targets the restored pristine test/ — and
// passWithNoTests: false means a broken restore (no tests found) FAILS the
// judge, never passes it.
export default { test: { environment: 'node', include: ['test/**/*.test.ts'], passWithNoTests: false } };
