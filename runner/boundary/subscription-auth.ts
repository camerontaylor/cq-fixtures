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
export function privateCodexAuthContext(accessOnly = false): { directory: string; auth: string } {
  const fd = openSync(join(homedir(), '.codex/auth.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let auth: string;
  try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 1024 * 1024 || stat.nlink !== 1) throw new Error('plain bounded auth file required'); const input = JSON.parse(readFileSync(fd, 'utf8')); auth = accessOnly ? accessOnlyCodexSubscription(input, 900) : minimalCodexSubscription(input); }
  finally { closeSync(fd); }
  const directory = mkdtempSync(join(tmpdir(), 'cq-s5-subscription-private-')); chmodSync(directory, 0o700);
  writeFileSync(join(directory, 'auth.json'), auth, { mode: 0o600, flag: 'wx' });
  writeFileSync(join(directory, 'inventory.json'), JSON.stringify({ files: [{ path: 'auth.json', mode: '0600', sha256: createHash('sha256').update(auth).digest('hex') }], parentOwned: true, credentialsPrivate: true, accessOnly, maxRunSeconds: accessOnly ? 900 : null, expirySafetySeconds: accessOnly ? 120 : null, stagedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
  return { directory, auth };
}

/** External-token mode has no native refresh-token authority (Codex 0.155.1).
 * JWT expiry is a scheduling guard, not local signature verification.
 */
export function accessOnlyCodexSubscription(input: unknown, budgetSeconds: number, now = Date.now()): string {
  if (!Number.isInteger(budgetSeconds) || budgetSeconds < 1 || budgetSeconds > 900) throw new Error('bounded access-token budget required');
  const value = JSON.parse(minimalCodexSubscription(input));
  let expiry: unknown;
  try { expiry = JSON.parse(Buffer.from(value.tokens.access_token.split('.')[1], 'base64url').toString('utf8')).exp; }
  catch { throw new Error('access-token expiry unavailable'); }
  if (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry * 1000 < now + (budgetSeconds + 120) * 1000) throw new Error('access-token expiry budget unavailable');
  value.auth_mode = 'chatgptAuthTokens';
  value.tokens.refresh_token = '';
  // Native from_external_access_token derives token-info from this same JWT.
  value.tokens.id_token = value.tokens.access_token;
  value.last_refresh = new Date(now).toISOString();
  return JSON.stringify(value);
}
