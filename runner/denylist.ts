// F6 (WB-5.2a): the runner scans every persisted prediction artifact
// (worker patch / structured output) against the repo's denylist classes
// BEFORE publication. `scripts/denylist-scan` is the tree-scan implementation
// and is not importable (it runs at module load), so this is the minimal
// fail-closed reader for the SAME `policy/denylist/patterns.yml` format. It
// reads only the content `regex:` plus the optional path filter `path:` — the
// two shapes a per-artifact scan can act on (sample/description are probes,
// not matchers).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DenylistRule {
  id: string;
  regex: RegExp;
  /** Optional path filter: the rule only applies to paths this regex matches. */
  path?: RegExp;
}

// The policy tree scanner overlays credential rules from gitleaks. Artifact
// scanning runs without that binary, so retain a bounded credential check here
// too. Type-specific boundaries keep the suffix of task-<hash> from being
// mistaken for an API key. This is defense in depth, not a complete secret scan.
const CREDENTIAL_RULE: DenylistRule = {
  id: 'class:credential-material',
  regex: /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}\b)/,
};

/** Parse `policy/denylist/patterns.yml` rule regex/path lines. Fail-closed: 0 rules throws. */
export function loadDenylistRules(repoRoot: string): DenylistRule[] {
  const text = readFileSync(join(repoRoot, 'policy/denylist/patterns.yml'), 'utf8');
  const rules: DenylistRule[] = [];
  let cur: { id?: string; regex?: string; path?: string } | null = null;
  // Fail closed on a malformed rule: an id whose regex never parsed must not
  // be silently dropped from the scanner (a policy edit that breaks one rule
  // would otherwise shrink the denylist without a signal).
  const orphaned: string[] = [];
  const flush = () => {
    if (cur?.id === undefined) return;
    if (cur.regex === undefined) {
      orphaned.push(cur.id);
      return;
    }
    rules.push({
      id: cur.id,
      regex: new RegExp(cur.regex),
      ...(cur.path !== undefined ? { path: new RegExp(cur.path) } : {}),
    });
  };
  for (const raw of text.split(/\r?\n/)) {
    const id = /^\s*-\s*id:\s*(\S+)\s*$/.exec(raw);
    if (id !== null) {
      flush();
      cur = { id: id[1] };
      continue;
    }
    // Single-quoted YAML scalar; the only escape in single-quoted style is ''.
    const re = /^\s*regex:\s*'(.*)'\s*$/.exec(raw);
    if (re !== null && cur !== null) {
      cur.regex = re[1].replace(/''/g, "'");
      continue;
    }
    const p = /^\s*path:\s*'(.*)'\s*$/.exec(raw);
    if (p !== null && cur !== null) {
      cur.path = p[1].replace(/''/g, "'");
      continue;
    }
  }
  flush();
  if (orphaned.length > 0) {
    throw new Error(`denylist: rule(s) with no parsed regex: ${orphaned.join(', ')}`);
  }
  if (rules.length === 0) {
    throw new Error('denylist: no rules parsed from policy/denylist/patterns.yml');
  }
  return [...rules, CREDENTIAL_RULE];
}

/**
 * The first rule that matches `text`, honoring the rule's optional path
 * filter. A rule with a `path` filter applies only when `relPath` matches it
 * (the class:key-material-env / class:agent-scratch-paths rules are path
 * scoped, so they never blanket-match an artifact's content). `undefined`
 * means clean.
 */
export function findDenylistMatch(
  text: string,
  relPath: string,
  rules: readonly DenylistRule[],
): DenylistRule | undefined {
  for (const r of rules) {
    if (r.path !== undefined && !r.path.test(relPath)) continue;
    if (r.regex.test(text)) return r;
  }
  return undefined;
}
