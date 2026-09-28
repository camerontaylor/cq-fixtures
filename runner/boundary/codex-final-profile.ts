/** Boundary implementation only. Importing/preparing this module never calls a model. */
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync, constants, openSync, closeSync, fstatSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { privateCodexAuthContext } from './subscription-auth.ts';
import { compileContainerBoundary, spawnContainerBoundary } from './container.ts';
import type { ContainerBoundarySpec } from './container.ts';
import { containerPreparer } from './container-prepare.ts';
import { containerTaskSession } from './task-session.ts';
import { validateStageReceipt } from './task-staging.ts';
import type { TaskStageReceipt } from './task-staging.ts';

export const FINAL_CODEX_CONFIG_HASH = '8451e107ce3833b01bd6e96f748c783ec7021a9b6b857a4a1325ab9d339a5c03';
export const FINAL_BROKER_IDENTITY = 'c6d8d0b3dba5ac98779663e4cc75b92107fddb14430fc42180f4ec675c0f99b0';
export const FINAL_NATIVE_IMAGE = 'sha256:2a9422f0de75079fd81da5a5b68bf9936e72ce22e30d1a22ddd91bc77201de4e';
export const FINAL_BROKER_IMAGE = 'sha256:a0af04214c67a25e4c5ab01b20f6e6deea98fc664b65ae5532576949234adfe3';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** PRIVATE return value; parent stages ONLY auth.json/config.toml, not inventory. */
export function prepareFinalCodexContext(configFile: string): { directory: string; privateRoot: string } {
  const fd = openSync(configFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let config: string;
  try { const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192) throw new Error('plain frozen config required'); config = readFileSync(fd, 'utf8'); }
  finally { closeSync(fd); }
  if (hash(config) !== FINAL_CODEX_CONFIG_HASH) throw new Error('final native config identity changed');
  const context = privateCodexAuthContext(true);
  const directory = join(context.directory, 'payload'); mkdirSync(directory, { mode: 0o700 });
  renameSync(join(context.directory, 'auth.json'), join(directory, 'auth.json'));
  writeFileSync(join(directory, 'config.toml'), config, { mode: 0o600, flag: 'wx' });
  const inventory = JSON.parse(readFileSync(join(context.directory, 'inventory.json'), 'utf8'));
  inventory.files[0].path = 'payload/auth.json'; inventory.files.push({ path: 'payload/config.toml', mode: '0600', sha256: hash(config) });
  writeFileSync(join(context.directory, 'inventory.json'), JSON.stringify(inventory), { mode: 0o600 });
  chmodSync(context.directory, 0o700);
  return { directory, privateRoot: context.directory };
}

export function validateFinalCodexAuth(auth: string, budgetSeconds: number, now = Date.now()): void {
  if (!Number.isInteger(budgetSeconds) || budgetSeconds < 1 || budgetSeconds > 900) throw new Error('final profile requires bounded run budget');
  try {
    const value = JSON.parse(auth);
    if (value.auth_mode !== 'chatgptAuthTokens' || value.OPENAI_API_KEY !== null || value.tokens.refresh_token !== '' ||
        value.tokens.id_token !== value.tokens.access_token || typeof value.tokens.account_id !== 'string' || !value.tokens.account_id ||
        Object.keys(value).some((k) => !['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh'].includes(k)) ||
        Object.keys(value.tokens).sort().join(',') !== 'access_token,account_id,id_token,refresh_token') throw new Error();
    const expiry = JSON.parse(Buffer.from(value.tokens.access_token.split('.')[1], 'base64url').toString('utf8')).exp;
    if (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry * 1000 <= now + (budgetSeconds + 120) * 1000) throw new Error();
  } catch { throw new Error('private access-only auth or expiry budget invalid'); }
}

export interface FinalProfileAdmission {
  admissionId: string;
  stage: 'final-profile-G1' | 'actual-route-G2';
  profile: 'cq-subscription-http';
  boundaryIdentity: string;
  invocationIdentity: string;
  expiresAt: number;
  heldOut: false;
}
export function validateFinalAdmission(receipt: FinalProfileAdmission, expected: { stage: FinalProfileAdmission['stage']; boundaryIdentity: string; invocationIdentity: string }, now = Date.now()): void {
  if (!receipt || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(receipt.admissionId) || receipt.stage !== expected.stage ||
      receipt.profile !== 'cq-subscription-http' || receipt.boundaryIdentity !== expected.boundaryIdentity ||
      receipt.invocationIdentity !== expected.invocationIdentity || receipt.heldOut !== false ||
      !Number.isFinite(receipt.expiresAt) || receipt.expiresAt <= now || receipt.expiresAt > now + 900000) throw new Error('distinct final-profile parent admission required');
}

/** Recognize the native Sol/low invocation exactly; translate host cwd and supply
 * frozen provider overrides while retaining --ignore-user-config for ambient denial.
 */
export function finalCodexArguments(args: readonly string[], hostTaskRoot: string): string[] {
  const expected = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', 'danger-full-access', '-C', resolve(hostTaskRoot), '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort="low"', '-'];
  if (JSON.stringify(args) !== JSON.stringify(expected)) throw new Error('exact declared Codex Sol/low arguments required');
  const result = [...expected.slice(0, -1)]; result[7] = '/task';
  for (const setting of [
    'model_provider="cq-subscription-http"',
    'cli_auth_credentials_store="file"',
    'model_providers.cq-subscription-http.name="CQ HTTP-only managed subscription"',
    'model_providers.cq-subscription-http.base_url="http://172.29.249.2:8080/route/codex/backend-api/codex"',
    'model_providers.cq-subscription-http.wire_api="responses"',
    'model_providers.cq-subscription-http.requires_openai_auth=true',
    'model_providers.cq-subscription-http.supports_websockets=false',
  ]) result.push('-c', setting);
  result.push('-'); return result;
}

/** Bootstrap bytes are part of invocation identity. No shell interpolation/token argv. */
export const CODEX_FINAL_BOOTSTRAP = `const fs=require('fs'),cp=require('child_process'),crypto=require('crypto');
try{
const budget=Number(process.argv[1]),args=JSON.parse(process.argv[2]);
const read=p=>{const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.size>1048576)throw Error();return fs.readFileSync(fd,'utf8')}finally{fs.closeSync(fd)}};
const auth=read('/context/auth.json'),config=read('/context/config.toml'),a=JSON.parse(auth),exp=JSON.parse(Buffer.from(a.tokens.access_token.split('.')[1],'base64url')).exp;
if(a.auth_mode!=='chatgptAuthTokens'||a.OPENAI_API_KEY!==null||a.tokens.refresh_token!==''||a.tokens.id_token!==a.tokens.access_token||!Number.isInteger(budget)||budget<1||budget>900||!Number.isFinite(exp)||exp*1000<=Date.now()+(budget+120)*1000||crypto.createHash('sha256').update(config).digest('hex')!=='${FINAL_CODEX_CONFIG_HASH}')throw Error();
fs.mkdirSync('/home/worker/.codex',{recursive:true,mode:448});
fs.writeFileSync('/home/worker/.codex/auth.json',auth,{mode:384,flag:'wx'});fs.writeFileSync('/home/worker/.codex/config.toml',config,{mode:384,flag:'wx'});
const child=cp.spawn('/usr/local/bin/codex',args,{cwd:'/task',stdio:'inherit',env:{HOME:'/home/worker',CODEX_HOME:'/home/worker/.codex',PATH:'/usr/local/bin:/usr/bin:/bin',TMPDIR:'/tmp',LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
child.on('error',()=>process.exit(125));child.on('exit',(code)=>process.exit(code??125));
}catch{process.exit(125)}`;

/** Native owner plugs receipt into runSupervised. Must await terminate then finalize
 * on every terminal path; preserve boundary/unverified scope, never visible/disabled.
 */
export function createFinalCodexSpawnAdapter(input: {
  specification: ContainerBoundarySpec; staging: TaskStageReceipt;
  broker: { containerId: string; imageId: string; configPath: string };
  hostTaskRoot: string; exportRoot: string; budgetSeconds: number;
  stage: FinalProfileAdmission['stage'];
  /** REQUIRED authoritative parent service: independently preregister source/assignment,
   * boundary and invocation identities; consume an exclusive wx replay ledger before
   * returning. Never implement as a passthrough echo. Provision failures consume it.
   * Native owner enforces a whole-provision deadline in addition to runtime budget. */
  admit: (request: { stage: FinalProfileAdmission['stage']; boundaryIdentity: string; invocationIdentity: string }) => Promise<FinalProfileAdmission>;
}) {
  const spec = structuredClone(input.specification), staging = structuredClone(input.staging), broker = structuredClone(input.broker);
  if (spec.image !== FINAL_NATIVE_IMAGE) throw new Error('hard-pinned final native worker image required');
  validateStageReceipt(staging);
  const policy = compileContainerBoundary(spec);
  if (!['final-profile-G1', 'actual-route-G2'].includes(input.stage) || spec.network.brokerIdentity !== FINAL_BROKER_IDENTITY ||
      spec.image !== FINAL_NATIVE_IMAGE || broker.imageId !== FINAL_BROKER_IMAGE || !spec.network.productionEligible || spec.network.brokerIP !== '172.29.249.2' ||
      spec.network.workerIP !== '172.29.249.3' || spec.network.port !== 8080 || spec.authenticationFiles.join(',') !== 'auth.json') throw new Error('frozen HTTP-only profile required');
  const files = staging.context.entries;
  if (files.length !== 2 || files.some((e) => e.kind !== 'file' || e.mode !== 0o600 || !['auth.json', 'config.toml'].includes(e.path))) throw new Error('only exact private auth/config context permitted');
  const content = (name: string) => { const entry = files.find((e) => e.path === name); if (!entry || entry.kind !== 'file' || typeof entry.data !== 'string') throw new Error('context file missing'); return Buffer.from(entry.data, 'base64').toString('utf8'); };
  if (hash(content('config.toml')) !== FINAL_CODEX_CONFIG_HASH) throw new Error('staged config changed');
  validateFinalCodexAuth(content('auth.json'), input.budgetSeconds);
  const hostTaskRoot = resolve(input.hostTaskRoot), exportRoot = resolve(input.exportRoot), stage = input.stage, budget = input.budgetSeconds, admit = input.admit;
  let used = false;
  return async (command: string, args: readonly string[], options: { cwd: string }) => {
    if (used || command !== '/usr/local/bin/codex' || resolve(options.cwd) !== hostTaskRoot || !args.length || args[0] !== 'exec' || args.some((a) => typeof a !== 'string' || a.includes('\0'))) throw new Error('single exact final-profile native invocation required');
    used = true;
    const finalArgs = finalCodexArguments(args, hostTaskRoot);
    validateFinalCodexAuth(content('auth.json'), budget);
    const invocationIdentity = hash(JSON.stringify({ boundaryIdentity: policy.identity, stage, executable: command, args: finalArgs, bootstrap: hash(CODEX_FINAL_BOOTSTRAP), budget }));
    const receipt = await admit({ stage, boundaryIdentity: policy.identity, invocationIdentity });
    validateFinalAdmission(receipt, { stage, boundaryIdentity: policy.identity, invocationIdentity });
    // Recheck after queued admission, before provisioning or releasing native process.
    validateFinalCodexAuth(content('auth.json'), budget);
    const prepare = containerPreparer(spec, staging, broker);
    const launched = await spawnContainerBoundary({ boundary: policy, executable: '/usr/local/bin/node', args: ['-e', CODEX_FINAL_BOOTSTRAP, String(budget), JSON.stringify(finalArgs)], purpose: 'actual-route', heldOut: false,
      admit: async () => ({ admissionId: receipt.admissionId }), prepare: async (args, identity) => {
        const prepared = await prepare(args, identity);
        try { validateFinalAdmission(receipt, { stage, boundaryIdentity: policy.identity, invocationIdentity }); validateFinalCodexAuth(content('auth.json'), budget); return prepared; }
        catch (error) { await prepared.dispose(); throw error; }
      } });
    const session = containerTaskSession(staging, launched.containerId);
    const lifecycle = finalContainerLifecycle({ child: launched.child, budgetSeconds: budget,
      terminate: async () => {
        let first: unknown; let failed = false;
        try { await session.terminate(); } catch (error) { first = error; failed = true; }
        try { await launched.dispose(); } catch (error) { if (!failed) { first = error; failed = true; } }
        if (failed) throw first;
      },
      exportTask: () => session.finalize(exportRoot), cleanup: () => session.cleanup(), closeControl: session.closeControl,
    });
    return { child: launched.child, boundaryIdentity: launched.boundaryIdentity, launchIdentity: launched.launchIdentity, admissionId: receipt.admissionId,
      environmentNames: ['HOME', 'CODEX_HOME', 'PATH', 'TMPDIR', 'LANG', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'],
      scope: 'boundary' as const, isolation: 'unverified' as const, heldOut: false as const,
      terminate: lifecycle.terminate, finalize: lifecycle.finalize,
    };
  };
}

/** Awaited lifecycle seam, exported for bounded synthetic race/failure checks.
 * It closes only the trusted Docker client config on failure, never recovery volumes.
 */
export function finalContainerLifecycle<T>(input: {
  child: { once: (event: 'close' | 'error', listener: () => void) => unknown; exitCode: number | null; signalCode: NodeJS.Signals | null };
  budgetSeconds: number; terminate: () => Promise<void>; exportTask: () => Promise<T>;
  cleanup: () => Promise<void>; closeControl: () => void;
}) {
  let stop: Promise<void> | undefined, final: Promise<T> | undefined;
  let firstTerminationError: unknown; let terminationFailed = false;
  const terminate = () => stop ??= (async () => {
    clearTimeout(timer);
    try { await input.terminate(); }
    catch (error) { firstTerminationError = error; terminationFailed = true; throw firstTerminationError; }
  })();
  const stopOnClose = () => { void terminate().catch(() => { /* retained original failure; awaited terminate/finalize rethrows */ }); };
  const timer = setTimeout(stopOnClose, input.budgetSeconds * 1000);
  input.child.once('close', stopOnClose); input.child.once('error', stopOnClose);
  // Listener installation alone misses children that exited before receipt creation.
  if (input.child.exitCode !== null || input.child.signalCode !== null) stopOnClose();
  return {
    terminate,
    finalize: () => final ??= (async () => {
      let failed = false;
      try {
        await terminate(); if (terminationFailed) throw firstTerminationError;
        const result = await input.exportTask(); await input.cleanup(); return result;
      } catch (error) { failed = true; throw error; }
      finally { try { input.closeControl(); } catch (error) { if (!failed) throw error; } }
    })(),
  };
}
