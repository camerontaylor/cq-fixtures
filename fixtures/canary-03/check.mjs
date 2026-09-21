// Thin judge shim for the canary-03 fixture. ALL judge logic lives in the
// shared, never-materialized fixtures/judge-lib.mjs.
import { runVitestJudge } from '../judge-lib.mjs';

runVitestJudge({ judgeUrl: import.meta.url, judgeLabel: 'canary-03 judge' });
