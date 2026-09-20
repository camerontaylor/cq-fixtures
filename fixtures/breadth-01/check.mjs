// Thin judge shim for the breadth-01 fixture. ALL judge logic lives in the
// shared, never-materialized fixtures/judge-lib.mjs — see it for the full
// immutable-judge contract. This shim only identifies WHICH fixture it judges.
import { runVitestJudge } from '../judge-lib.mjs';

runVitestJudge({ judgeUrl: import.meta.url, judgeLabel: 'breadth-01 judge' });
