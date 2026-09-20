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
# published version is the source of truth). Any failure after the
# rewrite restores package.json + package-lock.json from backups (taken first), so a failed
# run never bricks its own retry. Refuses to run when the
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

if [ ! -f "$ROOT/package-lock.json" ]; then
  echo "error: $ROOT/package-lock.json not found — cannot back it up for rollback" >&2
  exit 1
fi

# Rollback: every failure AFTER the rewrite restores package.json AND
# package-lock.json, so a failed run never bricks its own retry (without
# this, a re-run mis-reports "refusing a second flip" on the half-flipped
# tree — and without the lock half, the retry would start from a mixed
# tree the claim "every failure restores" would overreach on).
BACKUP_PKG="$FLIP_PKG.bak-flip"
BACKUP_LOCK="$ROOT/package-lock.json.bak-flip"
# A killed run leaves these behind with the ORIGINAL pre-flip content: a
# rerun must never overwrite them (that would restore a partial state and
# destroy the recovery copy). Refuse first, unconditionally.
if [ -e "$BACKUP_PKG" ] || [ -e "$BACKUP_LOCK" ]; then
  echo "error: stale .bak-flip backup from an interrupted flip — restore or remove it before retrying" >&2
  exit 1
fi
cp "$FLIP_PKG" "$BACKUP_PKG" || { echo "error: cannot back up $FLIP_PKG — refusing to flip without rollback" >&2; exit 1; }
cp "$ROOT/package-lock.json" "$BACKUP_LOCK" || { rm -f "$BACKUP_PKG"; echo "error: cannot back up $ROOT/package-lock.json — pkg backup removed; fix and re-run" >&2; exit 1; }
restore_all() {
  # Each copy guarded: restore_all runs under `set -e`-suppressed call
  # sites (`||`, `elif`, `if !`), so a bare failing cp would be silently
  # ignored and the caller would destroy the recovery copies anyway.
  cp "$BACKUP_PKG" "$FLIP_PKG" || { echo "error: restore of package.json failed — backups kept" >&2; return 1; }
  cp "$BACKUP_LOCK" "$ROOT/package-lock.json" || { echo "error: restore of package-lock.json failed — backups kept" >&2; return 1; }
  # Backups are removed by the restore itself: the live files now hold the
  # ORIGINAL content, so nothing needs recovering and the retry starts
  # clean. Only a KILLED run (no restore) leaves backups behind — those
  # still trip the stale-backup refusal above.
  rm -f "$BACKUP_PKG" "$BACKUP_LOCK"
  echo "note: package.json + package-lock.json restored to pre-flip state; fix the cause and re-run" >&2
}

# Flow: node rewrites package.json → npm syncs the lock (registry) →
# node verifies package.json + lock → shell removes toolkit.lock last, so
# a failed run never claims a completeness the tree does not have.
# Single node process per step: node startup is slow on some hosts.
# (The `|| rc=$?` capture: a bare `rc=$?` after a failing command never
# runs under `set -e`.)
rc=0
node -e '
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync(process.env.FLIP_PKG, "utf8"));
const current = pkg?.dependencies?.[process.env.FLIP_DEP];
if (typeof current !== "string" || !current.startsWith("file:")) {
  console.error(`error: ${process.env.FLIP_DEP} is not a file: spec (got: ${current}) — refusing a second flip`);
  process.exit(3);
}
(pkg.dependencies ??= {})[process.env.FLIP_DEP] = process.env.FLIP_VERSION;
fs.writeFileSync(process.env.FLIP_PKG, JSON.stringify(pkg, null, 2) + "\n");
' || rc=$?
# Exit 3 = pre-write refusal (nothing rewritten): drop the redundant
# backups and exit WITHOUT restoring, so no spurious restore note prints
# and the retry is not tripped by our own just-taken backups. Any other
# nonzero = post-write failure: restore and exit.
if [ "$rc" -eq 3 ]; then
  rm -f "$BACKUP_PKG" "$BACKUP_LOCK"
  exit 1
elif [ "$rc" -ne 0 ]; then
  restore_all
  exit 1
fi

# Sync the committed lock to the published version. A stale lock (still
# resolving the file: tarball) makes the next `npm ci` fail, so the flip
# is not complete without this. Aborts loudly on failure with both files
# restored (see restore_all above).
if ! (cd "$ROOT" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund); then
  echo "error: npm lock sync failed — package.json now asks for $FLIP_DEP@$FLIP_VERSION;" >&2
  echo "fix registry access and re-run (package.json + lock were restored; toolkit.lock kept)" >&2
  restore_all
  exit 1
fi

node -e '
const fs = require("node:fs");
const after = JSON.parse(fs.readFileSync(process.env.FLIP_PKG, "utf8"));
if (after?.dependencies?.[process.env.FLIP_DEP] !== process.env.FLIP_VERSION) {
  console.error("error: post-flip verification failed — dependency is not the requested version");
  process.exit(1);
}
const lockPath = process.env.FLIP_PKG.slice(0, -"package.json".length) + "package-lock.json";
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const dep = process.env.FLIP_DEP;
// lockfileVersion 3 reads packages[""], with a legacy `dependencies`
// fallback so a hand-maintained older lock fails on the pin, not the shape.
const locked = lock?.packages?.[""]?.dependencies?.[dep] ?? lock?.dependencies?.[dep]?.version;
if (locked !== process.env.FLIP_VERSION) {
  console.error(`error: post-flip verification failed — package-lock.json still pins ${dep}@${locked}`);
  process.exit(1);
}
// The tree entry must convert too: npm can keep a stale
// `resolved: file:vendor/...` when the tarball version coincides with the
// requested one, and the next `npm ci` (after vendor/ is gone) would fail
// fetching it. The entry must point at the registry, never at a file:.
const entry = lock?.packages?.[`node_modules/${dep}`] ?? lock?.dependencies?.[dep];
if (typeof entry?.resolved !== "string" || entry.resolved.startsWith("file:")) {
  console.error(`error: post-flip verification failed — package-lock.json entry still resolves ${dep} via ${entry?.resolved}`);
  process.exit(1);
}
' || { restore_all; exit 1; }

# Removal order: the pin first, the backups last — and the pin removal
# itself restores on failure, so even a failed rm keeps the tree retryable.
# The final cleanup warns instead of failing: the flip already succeeded,
# so an unlink failure must not misreport success as failure.
rm "$FLIP_LOCK" || { restore_all; exit 1; }
rm -f "$BACKUP_PKG" "$BACKUP_LOCK" || { echo "warning: flip succeeded but .bak-flip backups could not be removed — remove them by hand" >&2; }

echo "flipped $FLIP_DEP to $FLIP_VERSION; removed toolkit.lock."
echo "next (human, phase 5): rm -rf vendor node_modules && npm ci && npm run build && npm test"
