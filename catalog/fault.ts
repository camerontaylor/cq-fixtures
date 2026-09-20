// FAULT.json channel (plan WB-2.1). Loads and validates the authoritative
// per-fault record and applies its canonical fix. The record is fixture-side
// and lives OUTSIDE the materialized tree: for a fixture referenced as
// `fixtures/<name>`, the record is `fixtures/<name>.FAULT.json` — a sibling
// FILE, so the runner's `cpSync(join(repoRoot, c.fixture), workspace)` copies
// the directory without it (runner/index.ts). `test/breadth.test.ts` proves
// that unreachability against the real materializer.
//
// The suite case shape is untouched: this is not a suite field, and
// schema/suite.schema.json is unchanged (plan §5 F2 acceptance).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import { checkOperatorAssignment, operatorById, type BugType, type DifficultyBand, type OperatorSpec } from './operators.ts';

export interface FaultProvenance {
  origin: 'operator-catalog' | 'lm-injected' | 'diff-replay';
  generator: string;
  seed: number;
  engine_version: string;
}

export interface FaultValidation {
  f2p: string[];
  p2p: string[];
  fix: Record<string, string>;
}

export interface FaultAdequacy {
  file: string;
  delete: string;
}

export interface FaultTellAudit {
  critic: string;
  verdict: 'not-told' | 'told';
  notes?: string;
}

export interface FaultRecord {
  bug_type: BugType;
  failure_symptoms: string;
  operator: string;
  difficulty: DifficultyBand;
  provenance: FaultProvenance;
  validation: FaultValidation;
  adequacy?: FaultAdequacy;
  tell_audit?: FaultTellAudit;
}

const ajv = ajvFormats(new Ajv2020({ allErrors: true }));
const validateFaultDoc = ajv.compile(
  JSON.parse(readFileSync(new URL('../schema/fault.schema.json', import.meta.url), 'utf8')) as object,
);

/** The operators named by a (possibly '+'-joined combined) record. */
export function faultOperators(record: FaultRecord): OperatorSpec[] {
  return record.operator.split('+').map((id) => {
    const op = operatorById(id);
    if (op === undefined) throw new Error(`FAULT.json names unknown operator '${id}'`);
    return op;
  });
}

/**
 * A fix path must be a src/-relative POSIX path with no traversal segments.
 * The JSON Schema pins the prefix; this closes the `src/../../outside.ts`
 * hole a bare `^src/.*` pattern leaves open.
 */
function assertSafeFixPath(rel: string, label: string): void {
  if (
    rel.length === 0 ||
    rel.startsWith('/') ||
    rel.includes('\\') ||
    /^[A-Za-z]:/.test(rel) ||
    !rel.startsWith('src/') ||
    rel.split('/').includes('..')
  ) {
    throw new Error(`${label}: fix path '${rel}' must be a src/-relative path with no '..' segments`);
  }
}

/**
 * Enforce the catalog rules the JSON Schema cannot express: every named
 * operator must exist, must be registered for the record's tier, and a
 * non-easy record may not use a trivial-prone operator (plan WB-2.2).
 */
export function assertFaultCatalogRules(record: FaultRecord, label: string): void {
  for (const id of record.operator.split('+')) {
    const check = checkOperatorAssignment(id, record.difficulty);
    if (!check.ok) throw new Error(`${label}: ${check.reason}`);
  }
  for (const rel of Object.keys(record.validation.fix)) assertSafeFixPath(rel, label);
  if (record.adequacy !== undefined) assertSafeFixPath(record.adequacy.file, label);
}

/** Parse + schema-validate + catalog-check one FAULT.json document. */
export function parseFaultRecord(raw: string, label: string): FaultRecord {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label}: not valid JSON: ${(e as Error).message}`);
  }
  if (!validateFaultDoc(doc)) {
    throw new Error(`${label}: failed fault.schema.json validation: ${ajv.errorsText(validateFaultDoc.errors)}`);
  }
  const record = doc as FaultRecord;
  assertFaultCatalogRules(record, label);
  return record;
}

/** Repo-root-relative path of a fixture's FAULT.json sibling. */
export function faultRecordRelPath(fixtureRef: string): string {
  const trimmed = fixtureRef.replace(/\/+$/, '');
  if (
    trimmed === '' ||
    trimmed.startsWith('/') ||
    trimmed.includes('\\') ||
    /^[A-Za-z]:/.test(trimmed) ||
    trimmed.split('/').includes('..')
  ) {
    throw new Error(`fixture ref '${fixtureRef}' must be repo-root-relative with no '..' segments`);
  }
  return `${trimmed}.FAULT.json`;
}

export function faultRecordAbsPath(repoRoot: string, fixtureRef: string): string {
  return join(repoRoot, faultRecordRelPath(fixtureRef));
}

export function loadFaultRecord(absPath: string): FaultRecord {
  return parseFaultRecord(readFileSync(absPath, 'utf8'), absPath);
}

export function loadFaultForFixture(repoRoot: string, fixtureRef: string): FaultRecord {
  return loadFaultRecord(faultRecordAbsPath(repoRoot, fixtureRef));
}

/**
 * Write a record's canonical fix into a materialized workspace. Paths in
 * `fix` are fixture-relative (`src/...`); the schema pins them to `src/` and
 * `assertFaultCatalogRules` rejects traversal, and this re-checks that the
 * resolved target stays inside the workspace before writing.
 */
export function applyFaultFix(record: FaultRecord, workspace: string): void {
  const workspaceRoot = resolve(workspace);
  for (const [rel, content] of Object.entries(record.validation.fix)) {
    assertSafeFixPath(rel, 'applyFaultFix');
    const target = resolve(workspaceRoot, rel);
    const relTarget = relative(workspaceRoot, target);
    if (relTarget.startsWith('..') || isAbsolute(relTarget)) {
      throw new Error(`applyFaultFix: fix path '${rel}' escapes the workspace`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}
