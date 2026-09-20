#!/usr/bin/env bash
# Flip cq-fixtures from the pre-publish `file:` tarball to the published toolkit.
#
# Phase-5 HUMAN step (plan §4 stage 3): prepared here, NEVER run in CI and
# NEVER run in this lane — executing it before the release would detach the
# repo from its pinned tarball with nothing published to install. No
# `npm publish` happens here or anywhere in this repo; this script only
# rewrites the local install spec. After the human runs it:
#   rm -rf vendor node_modules && npm ci && npm run build && npm test
#
# Usage: scripts/flip-to-published.sh <version>
#   e.g. scripts/flip-to-published.sh 1.0.0
#
# Effects: rewrites the `@camerontaylor/cq-toolkit` dependency in
# package.json from the `file:vendor/...` tarball to `<version>`, syncs
# `package-lock.json` to the published version (`npm install
# --package-lock-only`, needs the registry — without this the committed
# lock still points at the tarball and the next `npm ci` fails), and
# removes `toolkit.lock` (the pre-publish pin has no meaning once the
# published version is the source of truth). Refuses to run when the
# dependency is not a `file:` spec (the flip is one-way) or when
# toolkit.lock is absent.
#
# Test hook: FIXTURES_ROOT overrides the repo root (the test suite points it
# at a tmp dir with a fixture package.json + toolkit.lock); it defaults to
# this script's parent's parent.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: scripts/flip-to-published.sh <version>  (e.g. 1.0.0)" >&2
  exit 2
fi
VERSION="$1"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "error: '$VERSION' is not a semver version (expected e.g. 1.0.0)" >&2
  exit 2
fi

ROOT="${FIXTURES_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export FLIP_PKG="$ROOT/package.json"
export FLIP_LOCK="$ROOT/toolkit.lock"
export FLIP_DEP="@camerontaylor/cq-toolkit"
export FLIP_VERSION="$VERSION"

if [ ! -f "$FLIP_PKG" ]; then
  echo "error: $FLIP_PKG not found" >&2
  exit 1
fi
if [ ! -f "$FLIP_LOCK" ]; then
  echo "error: $FLIP_LOCK not found — nothing to flip from (already flipped?)" >&2
  exit 1
fi

# One node process rewrites package.json, removes the lock, and verifies
# (re-reading the file it just wrote): the dep must be exactly <version>
# and no file: spec may remain. Single process: node startup is slow on
# some hosts, and two invocations would double the script's wall time.
node -e '
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync(process.env.FLIP_PKG, "utf8"));
const current = pkg?.dependencies?.[process.env.FLIP_DEP];
if (typeof current !== "string" || !current.startsWith("file:")) {
  console.error(`error: ${process.env.FLIP_DEP} is not a file: spec (got: ${current}) — refusing a second flip`);
  process.exit(1);
}
pkg.dependencies[process.env.FLIP_DEP] = process.env.FLIP_VERSION;
fs.writeFileSync(process.env.FLIP_PKG, JSON.stringify(pkg, null, 2) + "\n");
' || exit 1

# Sync the committed lock to the published version. A stale lock (still
# resolving the file: tarball) makes the next `npm ci` fail, so the flip
# is not complete without this. Aborts loudly on failure — package.json is
# already rewritten at that point, and the message says how to finish.
if ! (cd "$ROOT" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund); then
  echo "error: npm lock sync failed — package.json now asks for $FLIP_DEP@$FLIP_VERSION;" >&2
  echo "finish by hand: npm install --package-lock-only (needs the registry), then remove toolkit.lock" >&2
  exit 1
fi

node -e '
const fs = require("node:fs");
const after = JSON.parse(fs.readFileSync(process.env.FLIP_PKG, "utf8"));
if (after?.dependencies?.[process.env.FLIP_DEP] !== process.env.FLIP_VERSION) {
  console.error("error: post-flip verification failed — dependency is not the requested version");
  process.exit(1);
}
if (Object.values(after.dependencies ?? {}).some((v) => String(v).startsWith("file:"))) {
  console.error("error: post-flip verification failed — a file: spec remains in dependencies");
  process.exit(1);
}
const lockPath = process.env.FLIP_PKG.slice(0, -"package.json".length) + "package-lock.json";
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const locked = lock?.packages?.[""]?.dependencies?.[process.env.FLIP_DEP];
if (locked !== process.env.FLIP_VERSION) {
  console.error(`error: post-flip verification failed — package-lock.json still pins ${process.env.FLIP_DEP}@${locked}`);
  process.exit(1);
}
' || exit 1

echo "flipped $FLIP_DEP to $FLIP_VERSION; removed toolkit.lock."
echo "next (human, phase 5): rm -rf vendor node_modules && npm ci && npm run build && npm test"
