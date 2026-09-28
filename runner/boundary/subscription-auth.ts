import { constants, openSync, fstatSync, readFileSync, closeSync, mkdtempSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createHash } from 'node:crypto';

/** Never log input/output or return tokens through public evidence. */
export function minimalCodexSubscription(input: unknown): string {
  const source = input as { auth_mode?: string; tokens?: Record<string, unknown>; last_refresh?: unknown };
  if (!source || !source.tokens || (source.auth_mode && source.auth_mode !== 'chatgpt')) throw new Error('managed ChatGPT subscription auth required');
  const tokens: Record<string, string> = {};
  for (const name of ['id_token', 'access_token', 'refresh_token', 'account_id']) {
    const value = source.tokens[name];
    if (typeof value !== 'string' || !value || value.length > 128 * 1024) throw new Error('managed subscription token fields unavailable');
    tokens[name] = value;
  }
  if (source.last_refresh !== undefined && typeof source.last_refresh !== 'string') throw new Error('invalid refresh metadata');
  return JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens, ...(source.last_refresh ? { last_refresh: source.last_refresh } : {}) });
}

/** Exact source only; resulting context/manifest remain parent-owned and private.
 * Manifest includes sensitive credential hash and must never enter public evidence.
 */
export function privateCodexAuthContext(): { directory: string; auth: string } {
  const fd = openSync(join(homedir(), '.codex/auth.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let auth: string;
  try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 1024 * 1024 || stat.nlink !== 1) throw new Error('plain bounded auth file required'); auth = minimalCodexSubscription(JSON.parse(readFileSync(fd, 'utf8'))); }
  finally { closeSync(fd); }
  const directory = mkdtempSync(join(tmpdir(), 'cq-s5-subscription-private-')); chmodSync(directory, 0o700);
  writeFileSync(join(directory, 'auth.json'), auth, { mode: 0o600, flag: 'wx' });
  writeFileSync(join(directory, 'inventory.json'), JSON.stringify({ files: [{ path: 'auth.json', mode: '0600', sha256: createHash('sha256').update(auth).digest('hex') }], parentOwned: true, credentialsPrivate: true }), { mode: 0o600, flag: 'wx' });
  return { directory, auth };
}
