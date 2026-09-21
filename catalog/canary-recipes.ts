// Contamination-canary recipes (plan WB-6, F7 slice B). Four synthetic
// reproductions of well-known public BUG CLASSES — not benchmark instances —
// seeded into `suites/fixer-worker/canary/`, which is reported separately and
// never enters the headline breadth tables. They reuse the same substrate
// library and the same deterministic generator as the breadth corpus
// (`catalog/generate-cases.ts`), so a canary passes the identical both-states +
// adequacy filter chain as any breadth case.
//
// These recipes are DELIBERATELY kept out of `CASE_RECIPES` (the breadth mix)
// and out of every matrix-discovery root. Each record carries a public
// reference and license note; no third-party code is vendored — the references
// are documentation of the bug class only.

import type { CaseRecipe } from './recipes.ts';

/** The license posture shared by every canary: behavior reproduced, nothing copied. */
const CANARY_LICENSE = 'no code vendored; reference is documentation only';
const CANARY_GENERATOR = 'canary:public-bug-class';
const CANARY_ENGINE = 'synthetic-canary';
const NOT_TOLD = 'lane-leader adversarial diff read (tests withheld)' as const;

/**
 * The four canary cases. `seed: 0` and `engine_version: 'synthetic-canary'`
 * record that these are hand-placed reproductions rather than engine-generated
 * mutants; the shared provenance fields keep the record shape identical to the
 * breadth corpus (schema/fault.schema.json).
 *
 * Each `p2p` list exhaustively covers the substrate's remaining declared test
 * titles (the schedule and graph substrates declare five tests, validate four;
 * merge declares two), so no title is left unaccounted for and every p2p entry
 * is proven green in both states by the shared filter chain.
 */
export const CANARY_RECIPES: readonly CaseRecipe[] = [
  // canary-01 — half-open interval overlap off-by-one (boundary shift).
  {
    id: 'canary-01',
    substrate: 'schedule',
    difficulty: 'medium',
    origin: 'public-bug-canary',
    operator: 'equality-boundary',
    bugType: 'operator misuse',
    failureSymptoms: 'overlaps reports back-to-back slots as overlapping when one slot ends exactly as the other starts.',
    mutations: [{ file: 'src/slots.ts', find: 'bStart < aEnd', replace: 'bStart <= aEnd' }],
    f2p: ['does not overlap when one slot ends as the other starts'],
    p2p: ['measures the minutes between two times', 'formats minutes as hours and minutes', 'treats Sunday as a weekend day', 'orders slots by start time'],
    adequacy: { file: 'src/slots.ts', delete: 'return aStart < bEnd && bStart < aEnd;' },
    tellAudit: { critic: NOT_TOLD, verdict: 'not-told', notes: 'Canary: the classic half-open interval overlap rule, reproduced synthetically.' },
    generator: CANARY_GENERATOR,
    seed: 0,
    engineVersion: CANARY_ENGINE,
    reference: 'half-open interval overlap off-by-one (Allen interval algebra: overlaps = aStart < bEnd && bStart < aEnd)',
    license: CANARY_LICENSE,
  },

  // canary-02 — shared-reference return / aliasing of internal mutable state.
  {
    id: 'canary-02',
    substrate: 'graph',
    difficulty: 'medium',
    origin: 'public-bug-canary',
    operator: 'shared-reference-return',
    bugType: 'variable misuse',
    failureSymptoms: 'neighbors hands back its internal neighbour list, so mutating the returned array corrupts later results.',
    mutations: [{ file: 'src/paths.ts', find: 'return [...(adj[node] ?? [])];', replace: 'return (adj[node] ?? []);' }],
    f2p: ['returns a copy of the neighbour list'],
    p2p: ['counts the neighbours of a node', 'finds a directed edge', 'detects a self-loop among several nodes', 'returns false when the target is unreachable'],
    adequacy: { file: 'src/paths.ts', delete: 'return [...(adj[node] ?? [])];' },
    tellAudit: { critic: NOT_TOLD, verdict: 'not-told', notes: 'Canary: defensive-copy aliasing defect, reproduced synthetically.' },
    generator: CANARY_GENERATOR,
    seed: 0,
    engineVersion: CANARY_ENGINE,
    reference: 'defensive-copy aliasing defect: returning a live internal array (MDN Array.prototype.slice copy guidance)',
    license: CANARY_LICENSE,
  },

  // canary-03 — missing-radix parse (parseInt without base ten).
  {
    id: 'canary-03',
    substrate: 'validate',
    difficulty: 'medium',
    origin: 'public-bug-canary',
    operator: 'radix-coercion-drop',
    bugType: 'value misuse',
    failureSymptoms: 'parseAmount parses a hex-looking string as base sixteen instead of base ten.',
    mutations: [{ file: 'src/number.ts', find: 'parseInt(text, 10)', replace: 'parseInt(text)' }],
    f2p: ['parses a decimal string as base ten'],
    p2p: ['rejects an address without a dotted domain', 'keeps a value inside the range', 'lists the missing fields'],
    adequacy: { file: 'src/number.ts', delete: 'return parseInt(text, 10);' },
    tellAudit: { critic: NOT_TOLD, verdict: 'not-told', notes: 'Canary: the missing-radix parsing bug, reproduced synthetically.' },
    generator: CANARY_GENERATOR,
    seed: 0,
    engineVersion: CANARY_ENGINE,
    reference: 'missing-radix parseInt (MDN Web Docs parseInt radix parameter; ESLint radix rule)',
    license: CANARY_LICENSE,
  },

  // canary-04 — prototype pollution via unchecked merge keys.
  {
    id: 'canary-04',
    substrate: 'merge',
    difficulty: 'medium',
    origin: 'public-bug-canary',
    operator: 'remove-conditional',
    bugType: 'missing logic',
    failureSymptoms: 'merge copies dangerous keys from the source, so a crafted payload can pollute Object.prototype.',
    mutations: [
      {
        file: 'src/merge.ts',
        find: "    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;\n",
        replace: '',
      },
    ],
    f2p: ['does not pollute Object.prototype'],
    p2p: ['merges nested plain objects'],
    adequacy: { file: 'src/merge.ts', delete: "if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;" },
    tellAudit: { critic: NOT_TOLD, verdict: 'not-told', notes: 'Canary: the prototype-pollution bug class, reproduced synthetically.' },
    generator: CANARY_GENERATOR,
    seed: 0,
    engineVersion: CANARY_ENGINE,
    reference: 'lodash prototype-pollution advisories CVE-2019-10744 / CVE-2018-3721 (behavior only)',
    license: CANARY_LICENSE,
  },
];
