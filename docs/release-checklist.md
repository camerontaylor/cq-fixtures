# Fixtures release checklist (plan §6, fixtures-side rows)

Plan §6 gates the v1 release for **both** repos. This file is the
fixtures-side half: each row states what applies to `cq-fixtures`, its
standing, and the evidence. The toolkit-side rows live in the toolkit
repo; the release PR verifies both halves before the version tags land.

Standing legend: **done** (true today, enforced in CI), **prepared**
(ready, execution is a phase-5 human step), **phase-5** (decided at
release time, with the owner sign-off plan §6 requires).

## Rows

- [x] **MIT LICENSE from day one — done.** `LICENSE` at the repo root
  (phase-0 scaffold). Spec requires public-MIT in both repos.
- [x] **Denylist CI scan green from the first commit — done.**
  `.github/workflows/denylist.yml` runs the tree scan plus `--self-test`
  on every push/PR with no trigger filters (I4), and the `drift` job
  fails when `policy/denylist/patterns.yml` drifts from
  `cq-toolkit@main` upstream. Must-never-publish classes (plan §6:
  hostnames, token/ssh plumbing, client names, personal paths, route
  config, agent memory-corpus paths, `vp`, webfront package names,
  `*.env*` with key material) are enforced by the shared pattern set,
  not by convention.
- [x] **No history hygiene needed by construction — done.** Greenfield
  repo; no webfront git history was ever carried. CI denylist replaces
  filter-repo auditing (plan §6).
- [x] **Secrets posture: GitHub secrets only — done.** The tree holds no
  env files with key material (denylist-enforced); live-matrix jobs read
  `Z_AI_API_KEY` / `DEEPSEEK_API_KEY` from Actions secrets only.
- [x] **Toolkit consumed strictly through its public package surface —
  done.** `test/boundary.test.ts` scans the runner sources, the
  packaging scripts, **and the built `dist/` output** (`npm run build`,
  `tsconfig.build.json`): only the bare `@camerontaylor/cq-toolkit`
  specifier may appear — no `src/`/`dist/` deep import, no subpath, no
  relative escape. The dist leg proves the discipline survives
  compilation. Until publish, the package arrives as the
  `file:vendor/cq-toolkit-0.0.0.tgz` tarball packed at the
  `toolkit.lock` tag (`scripts/pack-toolkit.sh`); `vendor/` is
  gitignored build output, never committed.
- [ ] **Flip to the published version — prepared, NOT executed (phase-5
  human step).** `scripts/flip-to-published.sh <version>` rewrites the
  dependency from the `file:` tarball to the published version, syncs
  `package-lock.json` via `npm install --package-lock-only` (a stale lock
  would fail the next `npm ci`), and removes `toolkit.lock`; it refuses a
  second run, non-semver input, a failed lock sync, a lock whose tree
  entry still resolves via `file:` (stale-entry guard), and a pre-existing
  `.bak-flip` backup (never overwrites recovery) — every post-write
  failure restores `package.json` + `package-lock.json` from backup so a failed run never bricks its own
  retry (contract proven by `test/flip.test.ts`, which runs the script
  hermetically against a tmp sandbox — the real tree is never flipped
  by a test). Plan §4 stage 3: run by the human at release, then
  `rm -rf vendor node_modules && npm ci && npm run build && npm test`.
- [ ] **Pack inspection / `files` allowlist — phase-5.** `cq-fixtures`
  is `private: true` and is never published, so there is no tarball to
  audit; the analogues hold today: `vendor/` + `dist/` are gitignored
  (never shipped by accident) and the denylist scan covers the tree.
  At release the human confirms the flipped `npm ci` resolves the
  published toolkit and the full gate run is green.
- [x] **README documents the suite/scoring schema — done.** `README.md`
  (comparison-table reading guide, eval axes, cost-basis honesty rules)
  plus `schema/README.md`, `suites/README.md`, `fixtures/README.md`,
  `runner/README.md`, and per-snapshot rendering (`reports/README.md`).
- [x] **Agent scratch directories gitignored — done.** `.gitignore`
  covers `.zcode/`, `.paseo/`, `.claude/` runtime artifacts (plus
  `node_modules/`, `dist/`, `vendor/`, `*.env*`, `tmp/`) — the plan §6
  leak vector from 2026-09-14. Never `git add -A`; stage explicit
  paths.
- [ ] **Design debt DD-1..DD-9 dispositioned; DD-9 gates the release —
  phase-5.** Each debt is closed with evidence or explicitly re-filed
  as post-v1 **with owner sign-off recorded in the release PR**; DD-9
  (governor token budget independent of `maxUsd`, modeled-vs-billed
  cost basis) is correctness/safety on merged code and is not
  deferrable polish. A debt may ship unresolved; never unreviewed.
- [ ] **Release lands whole — phase-5.** Single version tag on each
  repo; the DoD checklist verified in the release PR description. The
  fixtures release step is the flip above plus a green full-matrix
  snapshot on the flipped tree — never "flip and tag blind".
