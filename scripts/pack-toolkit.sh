#!/usr/bin/env bash
# Pack the pinned cq-toolkit into an npm-installable tarball.
#
# WHY: cq-fixtures consumes the toolkit only via its public npm package
# surface. Until it is published, the toolkit is pinned by git tag or full
# commit SHA in toolkit.lock (exactly one line), built here, and `npm pack`ed
# into vendor/.
# The tarball is a build artifact — never committed (vendor/ is gitignored);
# re-run this script to reproduce it.
#
# Usage: scripts/pack-toolkit.sh [--print-pin-kind] [tag-or-commit-sha]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# TOOLKIT_LOCK / TOOLKIT_REPO_URL exist so the pin-kind resolution below is
# hermetically testable (test/lock.test.ts); production uses the defaults.
LOCK="${TOOLKIT_LOCK:-$REPO_ROOT/toolkit.lock}"
REPO_URL="${TOOLKIT_REPO_URL:-https://github.com/camerontaylor/cq-toolkit.git}"
# npm names scoped tarballs "<scope>-<name>-<version>.tgz"; the flat name is
# what package.json's file: spec installs. Both names change iff the version
# does, so a mismatch below means the pin/version moved and docs must follow.
PACKED="camerontaylor-cq-toolkit-1.0.1.tgz"
EXPECTED="cq-toolkit-1.0.1.tgz"

# Pin: argv overrides, else the single non-empty line in toolkit.lock. The
# pin is a branch/tag NAME or a full 40-hex commit SHA (interim post-v1.0.0
# pin, plan §8.6) — a SHA cannot ride `git clone --branch`.
PRINT_KIND=0
TAG_ARG=""
for arg in "$@"; do
  case "$arg" in
    --print-pin-kind) PRINT_KIND=1 ;;
    -*) echo "usage: scripts/pack-toolkit.sh [--print-pin-kind] [tag-or-commit-sha]" >&2; exit 2 ;;
    *)
      if [ -n "$TAG_ARG" ]; then
        echo "usage: scripts/pack-toolkit.sh [--print-pin-kind] [tag-or-commit-sha]" >&2
        exit 2
      fi
      TAG_ARG="$arg"
      ;;
  esac
done

if [ -n "$TAG_ARG" ]; then
  TAG="$TAG_ARG"
else
  if [ ! -f "$LOCK" ]; then
    echo "error: $LOCK not found — it must pin the toolkit tag or full commit SHA as exactly one line (e.g. phase-1-done or 40 hex chars)" >&2
    exit 1
  fi
  count="$(grep -c . "$LOCK" || true)"
  if [ "$count" -ne 1 ]; then
    echo "error: $LOCK must contain exactly one non-empty line (the pinned tag or commit SHA); found $count" >&2
    exit 1
  fi
  TAG="$(grep . "$LOCK")"
fi

PIN_KIND=tag
# Uppercase A-F is hex too: normalize before the case match so an uppercase
# 40-char pin follows the commit-fetch path instead of being read as a tag
# (git accepts uppercase hex object names).
NORMALIZED_TAG="$(printf '%s' "$TAG" | tr '[:upper:]' '[:lower:]')"
case "$NORMALIZED_TAG" in
  *[!0-9a-f]*) ;;
  *) if [ "${#TAG}" -eq 40 ]; then PIN_KIND=commit; fi ;;
esac

# Diagnostic used by test/lock.test.ts (and useful when a pin looks wrong):
# print the resolved kind and exit before any clone/network work.
if [ "$PRINT_KIND" -eq 1 ]; then
  echo "$PIN_KIND"
  exit 0
fi

TMP="$(mktemp -d)"  # outside the repo so the clone never pollutes the worktree
trap 'rm -rf "$TMP"' EXIT

git init -q "$TMP/cq-toolkit"
cd "$TMP/cq-toolkit"
git remote add origin "$REPO_URL"
if [ "$PIN_KIND" = commit ]; then
  # A SHA is not a ref name: fetch exactly the pinned commit (GitHub serves
  # arbitrary SHAs by upload-pack) and check it out — a shallow
  # single-commit fetch. The SHA path is the strictly immutable pin.
  git fetch -q --depth 1 origin "$TAG"
else
  # Tag pin: fetch the explicit refs/tags/ namespace, so a BRANCH that
  # happens to share the name can never satisfy the lock (plan §8.6, and
  # `git clone --branch` would happily take a branch). A tag is the
  # conventional immutable pin; a force-moved tag is not, so a SHA pin is
  # the stronger form.
  git fetch -q --depth 1 origin "refs/tags/$TAG"
fi
git checkout -q FETCH_HEAD
if [ "$PIN_KIND" = commit ]; then
  # Verify the checkout is exactly the pinned commit — a mis-resolved fetch
  # must never silently build a different toolkit.
  RESOLVED="$(git rev-parse HEAD)"
  RESOLVED_NORM="$(printf '%s' "$RESOLVED" | tr '[:upper:]' '[:lower:]')"
  if [ "$RESOLVED_NORM" != "$NORMALIZED_TAG" ]; then
    echo "error: fetched commit $RESOLVED does not match the pinned SHA $TAG" >&2
    exit 1
  fi
fi
npm ci            # dist/ must be built before packing or the export map dangles
npm run build

mkdir -p "$REPO_ROOT/vendor"
# A previous run's tarball must never satisfy the verification below: a stale
# pass would silently install the WRONG toolkit version. Remove this
# package's tarballs (both npm's scoped name and our flat expected name)
# before packing, so existence checks can only pass on a fresh pack.
rm -f "$REPO_ROOT"/vendor/camerontaylor-cq-toolkit-*.tgz "$REPO_ROOT"/vendor/cq-toolkit-*.tgz
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

echo "packed @camerontaylor/cq-toolkit (pin: $TAG) -> $TARBALL"
