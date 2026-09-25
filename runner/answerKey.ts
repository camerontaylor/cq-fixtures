// W6.3 (RS-9 §4.3 A.5 + D): the runner-only answer key of an allowlist-built
// eval root, and the dynamic sentinel check.
//
// An eval root (scripts/eval-root.mjs) is the ONLY tree a run dispatches
// from. Its suites are stripped to what dispatch needs (id, fixture,
// task.prompt, probe.kind, probe.check), so the classifier's expected
// verdicts and label-sidecar flags live in a key file OUTSIDE the root, handed
// to the runner with --answer-key. The key also carries the root's sentinel:
// a random token planted in a file beside the fixtures (and in the key
// itself). A worker transcript, tool call, output or workspace that carries
// the token, the key's path, or the root's path reached outside its
// workspace — the case publishes no row and the run fails.

import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { z } from 'zod';

/** Marker file at the top of every built eval root; its presence makes --answer-key mandatory. */
export const EVAL_ROOT_MARKER = 'EVAL-ROOT.json';

const VERDICTS = ['actionable', 'responded', 'resolved', 'blocked', 'skip'] as const;

/** A classifier case's label-sidecar state, resolved at build time from the full repo. */
export const SIDECAR_STATUSES = ['flagged', 'absent', 'unparseable', 'unflagged', 'invalid'] as const;
export type SidecarStatus = (typeof SIDECAR_STATUSES)[number];

const KEY_SCHEMA = z.object({
  version: z.literal(1),
  /** Realpath of the eval root this key pairs with. */
  evalRoot: z.string().min(1),
  sentinel: z.object({
    token: z.string().regex(/^cq-sentinel-[0-9a-f]{32}$/),
    /** Absolute paths of every planted sentinel file (inside and outside the root). */
    plantedPaths: z.array(z.string().min(1)).min(1),
  }).strict(),
  /** Keyed by `<role>/<suite name>`; only expected-verdict suites carry entries. */
  suites: z.record(z.string(), z.object({
    cases: z.record(z.string(), z.object({
      expected: z.enum(VERDICTS),
      sidecar: z.enum(SIDECAR_STATUSES),
    }).strict()),
  }).strict()),
}).strict();

export type AnswerKey = z.infer<typeof KEY_SCHEMA>;
export type AnswerKeyCase = AnswerKey['suites'][string]['cases'][string];

/** Read and validate an answer key; throws with the path on any defect. */
export function loadAnswerKey(path: string): AnswerKey {
  try {
    return KEY_SCHEMA.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch (e) {
    throw new Error(`answer key '${path}' is missing or invalid: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The key entry for one case, or undefined when the key does not cover it. */
export function answerKeyCase(key: AnswerKey, role: string, suiteName: string, caseId: string): AnswerKeyCase | undefined {
  return key.suites[`${role}/${suiteName}`]?.cases[caseId];
}

/**
 * Fill a stripped suite document's expected verdicts from the key, BEFORE
 * schema validation, so the schema still requires every classifier case to
 * carry one. A suite that already carries answers, a case the key does not
 * cover, and a key entry the suite does not have are all load errors: a key
 * and a root drifting apart must never score against the wrong label.
 */
export function applyAnswerKey(doc: unknown, key: AnswerKey, dir: string): unknown {
  if (typeof doc !== 'object' || doc === null) return doc;
  const { role, name, cases } = doc as { role?: unknown; name?: unknown; cases?: unknown };
  if (typeof role !== 'string' || typeof name !== 'string' || !Array.isArray(cases)) return doc;
  const keyed = key.suites[`${role}/${name}`]?.cases ?? {};
  const seen = new Set<string>();
  const merged = cases.map((c: unknown) => {
    if (typeof c !== 'object' || c === null) return c;
    const { id, probe } = c as { id?: unknown; probe?: unknown };
    if (typeof id !== 'string' || typeof probe !== 'object' || probe === null) return c;
    if ((probe as { kind?: unknown }).kind !== 'expected-verdict') return c;
    if ('expected' in probe) {
      throw new Error(`suite at ${dir}: case '${id}' carries probe.expected, but an answer key was supplied — a run with a key reads only stripped eval-root suites`);
    }
    const entry = keyed[id];
    if (entry === undefined) throw new Error(`suite at ${dir}: the answer key has no entry for case '${id}' (${role}/${name})`);
    seen.add(id);
    return { ...c, probe: { ...probe, expected: entry.expected } };
  });
  const orphans = Object.keys(keyed).filter((id) => !seen.has(id));
  if (orphans.length > 0) {
    throw new Error(`suite at ${dir}: the answer key carries entries for cases the suite does not have: ${orphans.join(', ')}`);
  }
  return { ...(doc as object), cases: merged };
}

/**
 * The strings whose appearance in anything a worker produced proves it
 * reached outside its workspace: the token, the key file's path, every
 * planted sentinel path, and any path beneath the eval root (with its
 * separator, so a sibling such as `<root>-other` never matches).
 */
export function sentinelNeedles(key: AnswerKey, keyPath: string): string[] {
  const rootPrefix = key.evalRoot.endsWith(sep) ? key.evalRoot : key.evalRoot + sep;
  return [...new Set([key.sentinel.token, resolve(keyPath), rootPrefix, ...key.sentinel.plantedPaths])];
}

/** One scanned surface of a finished case (where it came from + its text). */
export interface SentinelSource {
  where: string;
  text: string | undefined;
}

/** The first surface carrying any needle, or undefined when the case is clean. */
export function findSentinel(needles: readonly string[], sources: Iterable<SentinelSource>): string | undefined {
  if (needles.length === 0) return undefined;
  for (const { where, text } of sources) {
    if (text !== undefined && needles.some((n) => text.includes(n))) return where;
  }
  return undefined;
}
