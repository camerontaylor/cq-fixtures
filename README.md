# cq-fixtures

Scored per-role task suites for the portable code-quality toolkit (`cq-toolkit`): seeded-fault suites and labeled review-thread cases, executed by a thin runner over the toolkit's own ops and reported as per-role comparison tables. Greenfield, public MIT from day one.

Setup: `./scripts/pack-toolkit.sh` must run before the first `npm ci` — it packs the toolkit at the tag pinned in `toolkit.lock` into `vendor/`, which `npm ci` installs as the `@camerontaylor/cq-toolkit` file: dependency.

schema: see schema/ (phase 2)
