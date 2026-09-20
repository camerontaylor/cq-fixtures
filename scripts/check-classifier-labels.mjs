#!/usr/bin/env node
// check-classifier-labels — F4 corpus gate: the label file is the authority,
// suite.json is the scored surface, and the two must never drift.
//
// For suites/review-classifier/breadth-verified + breadth-tail this script
// asserts, per case: the fixture-side sidecar `<fixture>.json` ->
// `<fixture>.label.json` exists and parses; sidecar.case == case id;
// sidecar.expected == probe.expected; sidecar.rule_chain_version == the
// version LABEL-GUIDE.md declares (EXPECTED_GUIDE_VERSION — bump the two
// together; a rule-chain change forces re-adjudication, never silent
// relabeling); and the task.notes tokens
// (`concern_group: <G>; fp_flag: <none|suspicious-benign>;
// adversarial_reply: <yes|no>`) agree with the sidecar field-for-field.
// Adjudication completeness: every breadth-verified case carries >= 2
// annotators with status agreed|adjudicated (no pending-pass2); the
// breadth-tail double-coded audit subset — DERIVED as the tail cases with
// >= 2 annotators, required to be exactly 6 — carries the same, while every
// other tail case must be status single-annotator. Corpus floors across the
// combined 60: suspicious-benign >= 20, adversarial_reply true >= 6,
// exactly 12 per verdict combined and exactly 6 per verdict per tier.
//
// Modes:
//   node scripts/check-classifier-labels.mjs
//     checks the real repo (root resolved from this script's location).
//   node scripts/check-classifier-labels.mjs --repo <root> --suites <a,b>
//     checks a COPY (the negative-test path): --repo is the repo root the
//     fixture/label/guide paths resolve against, --suites is a
//     comma-separated list of suite dirs RELATIVE to that root.
// Exit 0 prints the counts; any failure exits 1 with a FAIL line naming
// the case and the mismatch.
//
// Zero npm dependencies: node:fs, node:path only. Repo root is resolved
// from this script's location: the script lives at <root>/scripts/, so
// ".." relative to its directory is the repo root.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VERDICTS = ['actionable', 'responded', 'resolved', 'blocked', 'skip'];
const FP_FLAGS = ['none', 'suspicious-benign'];
const EXPECTED_GUIDE_VERSION = '1.0';
const DEFAULT_SUITES = [
  'suites/review-classifier/breadth-verified',
  'suites/review-classifier/breadth-tail',
];
const TAIL_AUDIT_SIZE = 6;

const failures = [];
function fail(msg) {
  failures.push(`FAIL ${msg}`);
}

function parseArgs(argv) {
  let repo = path.resolve(SCRIPT_DIR, '..');
  let suites = DEFAULT_SUITES;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') {
      i++;
      if (i >= argv.length) fail('flag --repo requires a value');
      else repo = path.resolve(argv[i]);
    } else if (argv[i] === '--suites') {
      i++;
      if (i >= argv.length) fail('flag --suites requires a value');
      else suites = argv[i].split(',').map((s) => s.trim()).filter((s) => s !== '');
    } else {
      fail(`unknown flag '${argv[i]}' (want --repo <root> | --suites <a,b>)`);
    }
  }
  return { repo, suites };
}

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Strict parse of the notes convention the runner's drift surface depends
// on: `concern_group: <G>; fp_flag: <none|suspicious-benign>;
// adversarial_reply: <yes|no>`. Anything else is drift by definition.
function parseNotes(notes, where) {
  if (typeof notes !== 'string') {
    fail(`${where}: task.notes is missing (want 'concern_group: <G>; fp_flag: <…>; adversarial_reply: <yes|no>')`);
    return null;
  }
  const m = /^concern_group: (.+); fp_flag: (none|suspicious-benign); adversarial_reply: (yes|no)$/.exec(notes.trim());
  if (!m) {
    fail(`${where}: task.notes '${notes}' does not match the drift-checked convention`);
    return null;
  }
  return { concern_group: m[1], fp_flag: m[2], adversarial_reply: m[3] === 'yes' };
}

function main() {
  const { repo, suites } = parseArgs(process.argv.slice(2));

  // The guide version is the single source of truth for the chain every
  // sidecar claims: labels pin rule_chain_version, the guide declares
  // `Version: **X.Y (...)`, and EXPECTED_GUIDE_VERSION pins the script to
  // the chain it was written against — a guide bump without a script bump
  // fails closed here instead of silently redefining verdicts.
  let guideVersion = null;
  try {
    const guide = fs.readFileSync(path.join(repo, 'suites/review-classifier/LABEL-GUIDE.md'), 'utf8');
    guideVersion = guide.match(/^Version: \*\*(\d+\.\d+)/m)?.[1] ?? null;
  } catch (e) {
    fail(`cannot read LABEL-GUIDE.md: ${e.message}`);
  }
  if (guideVersion === null) fail('LABEL-GUIDE.md declares no `Version: **X.Y` line');
  else if (guideVersion !== EXPECTED_GUIDE_VERSION) {
    fail(`LABEL-GUIDE.md declares version ${guideVersion}, script pins ${EXPECTED_GUIDE_VERSION} — bump together with re-adjudication`);
  }

  const combined = [];
  const perTier = [];
  for (const suiteDir of suites) {
    const suiteFile = path.join(repo, suiteDir, 'suite.json');
    const parsed = readJson(suiteFile);
    if (!parsed.ok) {
      fail(`cannot read ${suiteDir}/suite.json: ${parsed.error}`);
      continue;
    }
    const suite = parsed.value;
    const tier = path.basename(suiteDir);
    const tierLabels = [];
    for (const c of suite.cases ?? []) {
      const where = `${tier}/${c.id}`;
      // The sidecar path is a pure suffix swap on the fixture path, mirroring
      // the runner's suspiciousBenignFlag resolution — drift between the two
      // would silently unflag cases, so the swap is asserted here, not shared.
      if (typeof c.fixture !== 'string' || !c.fixture.endsWith('.json')) {
        fail(`${where}: fixture '${c.fixture}' is not a .json thread payload (sidecar path underivable)`);
        continue;
      }
      const sidecarFile = path.join(repo, `${c.fixture.slice(0, -'.json'.length)}.label.json`);
      const sidecar = readJson(sidecarFile);
      if (!sidecar.ok) {
        fail(`${where}: missing or unparseable sidecar ${path.relative(repo, sidecarFile)}: ${sidecar.error}`);
        continue;
      }
      const l = sidecar.value;
      if (l.case !== c.id) fail(`${where}: sidecar.case '${l.case}' != case id`);
      if (l.expected !== c.probe?.expected) fail(`${where}: sidecar.expected '${l.expected}' != probe.expected '${c.probe?.expected}'`);
      if (l.rule_chain_version !== guideVersion) {
        fail(`${where}: sidecar rule_chain_version '${l.rule_chain_version}' != guide ${guideVersion}`);
      }
      if (!VERDICTS.includes(l.expected)) fail(`${where}: sidecar.expected '${l.expected}' outside the verdict vocabulary`);
      if (!FP_FLAGS.includes(l.fp_flag)) fail(`${where}: sidecar.fp_flag '${l.fp_flag}' must be none|suspicious-benign`);
      if (typeof l.adversarial_reply !== 'boolean') fail(`${where}: sidecar.adversarial_reply must be boolean`);
      if (typeof l.concern_group !== 'string' || l.concern_group === '') fail(`${where}: sidecar.concern_group must be a non-empty string`);
      const notes = parseNotes(c.task?.notes, where);
      if (notes !== null) {
        if (notes.concern_group !== l.concern_group) fail(`${where}: notes concern_group '${notes.concern_group}' != sidecar '${l.concern_group}'`);
        if (notes.fp_flag !== l.fp_flag) fail(`${where}: notes fp_flag '${notes.fp_flag}' != sidecar '${l.fp_flag}'`);
        if (notes.adversarial_reply !== l.adversarial_reply) {
          fail(`${where}: notes adversarial_reply != sidecar.adversarial_reply (${l.adversarial_reply})`);
        }
      }
      const annotators = Array.isArray(l.annotators) ? l.annotators.length : 0;
      const status = l.adjudication?.status;
      if (tier === 'breadth-verified') {
        if (annotators < 2) fail(`${where}: verified tier needs >= 2 annotators, has ${annotators}`);
        if (status !== 'agreed' && status !== 'adjudicated') {
          fail(`${where}: verified adjudication.status '${status}' must be agreed|adjudicated (no pending-pass2)`);
        }
      } else {
        // Tail audit subset is DERIVED (cases with >= 2 annotators), never
        // hardcoded — a hardcoded list would let a dropped audit pass.
        if (annotators >= 2) {
          tierLabels.push({ id: c.id, audit: true });
          if (status !== 'agreed' && status !== 'adjudicated') {
            fail(`${where}: tail audit adjudication.status '${status}' must be agreed|adjudicated`);
          }
        } else {
          tierLabels.push({ id: c.id, audit: false });
          if (status !== 'single-annotator') {
            fail(`${where}: non-audit tail adjudication.status '${status}' must be single-annotator`);
          }
        }
      }
      combined.push(l);
      if (tier === 'breadth-verified') tierLabels.push({ id: c.id });
    }
    perTier.push({ tier, count: (suite.cases ?? []).length, audit: tierLabels.filter((t) => t.audit).length });
  }

  const tailTier = perTier.find((t) => t.tier === 'breadth-tail');
  if (tailTier !== undefined && tailTier.audit !== TAIL_AUDIT_SIZE) {
    fail(`breadth-tail double-coded audit subset is ${tailTier.audit}, want exactly ${TAIL_AUDIT_SIZE} (derived, not hardcoded)`);
  }

  // Corpus floors over the combined tiers.
  const byVerdict = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const l of combined) {
    if (byVerdict[l.expected] !== undefined) byVerdict[l.expected] += 1;
  }
  const benign = combined.filter((l) => l.fp_flag === 'suspicious-benign').length;
  const adversarial = combined.filter((l) => l.adversarial_reply === true).length;
  if (combined.length !== 60) fail(`combined corpus is ${combined.length} cases, want 60`);
  if (benign < 20) fail(`suspicious-but-benign is ${benign}/60, floor is 20`);
  if (adversarial < 6) fail(`adversarial-reply is ${adversarial}/60, floor is 6`);
  for (const v of VERDICTS) {
    if (byVerdict[v] !== 12) fail(`combined verdict '${v}' is ${byVerdict[v]}, want exactly 12`);
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(f);
    console.error(`classifier-labels: ${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log(
    `classifier-labels: OK — ${combined.length} cases ` +
    `(verified ${perTier.find((t) => t.tier === 'breadth-verified')?.count ?? 0} + ` +
    `tail ${tailTier?.count ?? 0} incl. ${tailTier?.audit ?? 0} double-coded audit), ` +
    `verdicts ${VERDICTS.map((v) => `${v}=${byVerdict[v]}`).join(' ')}, ` +
    `suspicious-benign=${benign} (floor 20), adversarial-reply=${adversarial} (floor 6)`,
  );
}

main();
