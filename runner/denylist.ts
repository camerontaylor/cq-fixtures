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

/** Parse `policy/denylist/patterns.yml` rule regex/path lines. Fail-closed: 0 rules throws. */
export function loadDenylistRules(repoRoot: string): DenylistRule[] {
  const text = readFileSync(join(repoRoot, 'policy/denylist/patterns.yml'), 'utf8');
  const rules: DenylistRule[] = [];
  let cur: { id?: string; regex?: string; path?: string } | null = null;
  const flush = () => {
    if (cur?.id !== undefined && cur.regex !== undefined) {
      rules.push({
        id: cur.id,
        regex: new RegExp(cur.regex),
        ...(cur.path !== undefined ? { path: new RegExp(cur.path) } : {}),
      });
    }
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
  if (rules.length === 0) {
    throw new Error('denylist: no rules parsed from policy/denylist/patterns.yml');
  }
  return rules;
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
