// Thin judge shim for the breadth-08 fixture. ALL judge logic lives in the
// shared, never-materialized fixtures/judge-lib.mjs.
import { runVitestJudge } from '../judge-lib.mjs';

runVitestJudge({ judgeUrl: import.meta.url, judgeLabel: 'breadth-08 judge' });
