// Suite loading: the SCHEMA layer (Ajv2020 + ajv-formats, same options as
// test/schema.test.ts) then the SEMANTIC layer the JSON Schema cannot express
// (issue #4): the role↔probe.kind pairing convention, unique case ids, and
// repo-root-relative fixture/check paths that cannot escape the repo.

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import type { SuiteRole } from './aggregate.ts';

export interface SuiteTask {
  prompt: string;
  notes?: string;
}

interface SuiteCaseBase {
  id: string;
  fixture: string;
  task: SuiteTask;
}

/** Discriminated by probe.kind so role scoring narrows statically. */
export interface FixerSuiteCase extends SuiteCaseBase {
  probe: { kind: 'check-rerun'; check: string };
}

export interface ClassifierSuiteCase extends SuiteCaseBase {
  probe: { kind: 'expected-verdict'; expected: string };
}

export type SuiteCase = FixerSuiteCase | ClassifierSuiteCase;

export interface Suite {
  name: string;
  role: SuiteRole;
  servedModel?: string;
  /** F6/CQ-4: optional prompt/tool-surface bundle id; absent means the default posture. */
  variant?: string;
  provenance: { origin: string; reference?: string };
  cases: SuiteCase[];
}

/** F6/CQ-4: the suite's variant id, defaulting to the default posture. */
export function suiteVariant(s: Suite): string {
  return s.variant ?? 'default';
}

// Type predicate: TS does not narrow the containing union through the nested
// discriminant (c.probe.kind), so role dispatch needs this to stay honest.
export function isFixerCase(c: SuiteCase): c is FixerSuiteCase {
  return c.probe.kind === 'check-rerun';
}

const ROLE_PROBE: Record<SuiteRole, SuiteCase['probe']['kind']> = {
  'fixer-worker': 'check-rerun',
  'review-classifier': 'expected-verdict',
};

const ajv = ajvFormats(new Ajv2020({ allErrors: true }));
const validateSuiteDoc = ajv.compile(
  JSON.parse(readFileSync(new URL('../schema/suite.schema.json', import.meta.url), 'utf8')) as object,
);

/** fixture/check paths must stay inside the repo: relative in POSIX form, no '..' segments, no Windows separators or drive prefixes. */
function assertRepoRelative(p: string, label: string, suiteName: string): void {
  if (
    p.length === 0 ||
    isAbsolute(p) ||
    p.includes('\\') || // a backslash is a separator on Windows — reject the ambiguity outright
    /^[A-Za-z]:/.test(p) || // Windows drive prefix (C:, C:/…, C:\…)
    p.split('/').includes('..')
  ) {
    throw new Error(
      `suite '${suiteName}': ${label} path '${p}' must be repo-root-relative ` +
        `(no leading '/', no '..' segments, no backslashes, no Windows drive prefix)`,
    );
  }
}

/** Read, schema-validate, and semantically enforce one suite directory. */
export function loadSuite(dir: string): Suite {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(join(dir, 'suite.json'), 'utf8'));
  } catch (e) {
    throw new Error(`cannot read suite at ${dir}: ${(e as Error).message}`);
  }
  if (!validateSuiteDoc(doc)) {
    throw new Error(`suite at ${dir} failed schema validation: ${ajv.errorsText(validateSuiteDoc.errors)}`);
  }
  const suite = doc as Suite;
  const seen = new Set<string>();
  for (const c of suite.cases) {
    if (seen.has(c.id)) throw new Error(`suite '${suite.name}': duplicate case id '${c.id}'`);
    seen.add(c.id);
    const expectedProbe = ROLE_PROBE[suite.role];
    if (c.probe.kind !== expectedProbe) {
      throw new Error(
        `suite '${suite.name}' case '${c.id}': role '${suite.role}' requires probe.kind '${expectedProbe}', got '${c.probe.kind}'`,
      );
    }
    assertRepoRelative(c.fixture, `case '${c.id}' fixture`, suite.name);
    if (c.probe.kind === 'check-rerun') assertRepoRelative(c.probe.check, `case '${c.id}' probe.check`, suite.name);
  }
  return suite;
}
