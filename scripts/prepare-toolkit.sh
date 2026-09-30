#!/usr/bin/env bash
# Install the interim pinned tarball, or validate the published dependency.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f toolkit.lock ]; then
  ./scripts/pack-toolkit.sh
else
  node --experimental-strip-types --input-type=module -e '
    import { readToolkitProvenance } from "./runner/provenance.ts";
    const provenance = readToolkitProvenance(process.cwd());
    if (!provenance.toolkitPackage) throw new Error("published toolkit provenance missing");
    console.log(`published toolkit ${provenance.toolkitPackage.version} integrity verified in lockfile`);
  '
fi
