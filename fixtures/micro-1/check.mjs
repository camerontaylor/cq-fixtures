// Thin judge shim for the micro-1 fixture. ALL judge logic lives in the
// shared, never-materialized fixtures/judge-lib.mjs — see it for the full
// immutable-judge contract (repo-root resolution from THIS file's URL,
// pristine test restore, planted-config scrub, explicit judge config).
// This shim only identifies WHICH fixture it judges; it is always read from
// the pristine repo, never from a workspace copy.
import { runVitestJudge } from '../judge-lib.mjs';

runVitestJudge({ judgeUrl: import.meta.url, judgeLabel: 'micro-1 judge' });
