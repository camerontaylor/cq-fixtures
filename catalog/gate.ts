// Corpus gate CLI (plan WB-6 §F7). `--check` runs the static evidence
// inventory only (no judge spawn); `--all` runs the full pipeline for every
// record-backed case. Either exits 1 on any issue/failure, so CI can gate on
// the cheap mode and a human can reproduce the executing proof locally.
//
//   node --experimental-strip-types catalog/gate.ts --check
//   node --experimental-strip-types catalog/gate.ts --all

import { checkCorpusEvidence, runCorpusGate } from './corpus.ts';
import { PIPELINE_REPO_ROOT } from './pipeline.ts';

function runCheck(repoRoot: string): number {
  const evidence = checkCorpusEvidence(repoRoot);
  if (evidence.issues.length === 0) {
    for (const c of evidence.recordBacked) console.log(`PASS ${c.suiteRel}/${c.caseId}`);
  } else {
    for (const issue of evidence.issues) console.log(`ISSUE ${issue}`);
  }
  console.log(`corpus evidence: ${evidence.recordBacked.length} record-backed / ${evidence.legacy.length} legacy / ${evidence.issues.length} issues`);
  return evidence.issues.length === 0 ? 0 : 1;
}

function runAll(repoRoot: string): number {
  const result = runCorpusGate(repoRoot, { full: true });
  for (const issue of result.issues) console.log(`ISSUE ${issue}`);
  for (const report of result.reports) {
    console.log(`${report.pass ? 'PASS' : 'FAIL'} ${report.caseId}`);
    for (const g of report.gates) if (!g.pass) console.log(`   ${g.gate}: ${g.detail}`);
  }
  console.log(`${result.reports.length - result.failed}/${result.reports.length} cases pass (full chain) · ${result.issues.length} issues`);
  return result.issues.length === 0 && result.failed === 0 ? 0 : 1;
}

function main(argv: readonly string[]): number {
  if (argv.length === 1 && argv[0] === '--check') return runCheck(PIPELINE_REPO_ROOT);
  if (argv.length === 1 && argv[0] === '--all') return runAll(PIPELINE_REPO_ROOT);
  console.error('usage: node --experimental-strip-types catalog/gate.ts (--check | --all)');
  return 2;
}

// Direct-invocation guard: importing this module must stay side-effect free.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
