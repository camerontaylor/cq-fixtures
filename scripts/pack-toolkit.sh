#!/usr/bin/env bash
# Pack the pinned cq-toolkit into an npm-installable tarball.
#
# WHY: cq-fixtures consumes the toolkit only via its public npm package
# surface. Until it is published, the toolkit is pinned by git tag in
# toolkit.lock (exactly one line), built here, and `npm pack`ed into vendor/.
# The tarball is a build artifact — never committed (vendor/ is gitignored);
# re-run this script to reproduce it.
#
# Usage: scripts/pack-toolkit.sh [tag]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$REPO_ROOT/toolkit.lock"
REPO_URL="https://github.com/camerontaylor/cq-toolkit.git"
# npm names scoped tarballs "<scope>-<name>-<version>.tgz"; the flat name is
# what package.json's file: spec installs. Both names change iff the version
# does, so a mismatch below means the pin/version moved and docs must follow.
PACKED="camerontaylor-cq-toolkit-0.0.0.tgz"
EXPECTED="cq-toolkit-0.0.0.tgz"

# Tag: argv overrides, else the single non-empty line in toolkit.lock.
if [ "$#" -gt 1 ]; then
  echo "usage: scripts/pack-toolkit.sh [tag]" >&2
  exit 2
elif [ "$#" -eq 1 ]; then
  TAG="$1"
else
  if [ ! -f "$LOCK" ]; then
    echo "error: $LOCK not found — it must pin the toolkit tag as exactly one line (e.g. phase-1-done)" >&2
    exit 1
  fi
  count="$(grep -c . "$LOCK" || true)"
  if [ "$count" -ne 1 ]; then
    echo "error: $LOCK must contain exactly one non-empty line (the pinned tag); found $count" >&2
    exit 1
  fi
  TAG="$(grep . "$LOCK")"
fi

TMP="$(mktemp -d)"  # outside the repo so the clone never pollutes the worktree
trap 'rm -rf "$TMP"' EXIT

git clone --depth 1 --branch "$TAG" "$REPO_URL" "$TMP/cq-toolkit"
cd "$TMP/cq-toolkit"
npm ci            # dist/ must be built before packing or the export map dangles
npm run build

mkdir -p "$REPO_ROOT/vendor"
npm pack --pack-destination "$REPO_ROOT/vendor/"

if [ ! -f "$REPO_ROOT/vendor/$PACKED" ]; then
  echo "error: npm pack produced no $PACKED — the toolkit version likely changed." >&2
  echo "Update package.json's file: spec and this script's PACKED/EXPECTED names, then re-run." >&2
  exit 1
fi
if [ "$PACKED" != "$EXPECTED" ]; then
  mv "$REPO_ROOT/vendor/$PACKED" "$REPO_ROOT/vendor/$EXPECTED"
fi
TARBALL="$REPO_ROOT/vendor/$EXPECTED"
if [ ! -f "$TARBALL" ]; then
  echo "error: expected tarball $TARBALL not found after pack" >&2
  exit 1
fi

echo "packed @camerontaylor/cq-toolkit@0.0.0 (tag: $TAG) -> $TARBALL"
