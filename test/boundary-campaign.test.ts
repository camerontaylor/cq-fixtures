import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { probeNativeVersion } from '../runner/boundary/version-probe.ts';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileBoundary } from '../runner/boundary/policy.ts';
import type { BoundarySpec } from '../runner/boundary/policy.ts';
import { probeHostBoundary } from '../runner/boundary/probes.ts';
import { spawnBoundary } from '../runner/boundary/spawn.ts';
import { compileBroker, createEgressBroker } from '../runner/boundary/egress-broker.ts';
import { compileContainerBoundary, spawnContainerBoundary } from '../runner/boundary/container.ts';
import type { ContainerBoundarySpec } from '../runner/boundary/container.ts';

const roots: string[] = [];
function fixture(): BoundarySpec {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cq-boundary-test-')));
  roots.push(root);
  const bundle = join(root, 'bundle'); mkdirSync(bundle);
  const dirs = Object.fromEntries(['task', 'context', 'home', 'tmp'].map((name) => {
    const path = join(bundle, name); mkdirSync(path); return [name, path];
  }));
  const hidden = join(root, 'hidden'); mkdirSync(hidden);
  writeFileSync(join(hidden, 'solution'), 'synthetic');
  return { bundle, task: dirs.task, context: dirs.context, home: dirs.home, temporary: dirs.tmp,
    toolchain: [], authentication: [], executables: [realpathSync(process.execPath)], forbidden: [hidden],
    endpoints: [], extensions: { mode: 'disabled', launchEvidence: null } };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('container fallback admission and egress', () => {
  function containerSpec(): ContainerBoundarySpec {
    return { profile: 'cq-boundary-s5', daemonId: 'synthetic-daemon', vmConfigHash: 'a'.repeat(64),
      image: 'node@sha256:' + 'b'.repeat(64), taskVolume: 'cq-s5-task-test', contextVolume: 'cq-s5-context-test',
      stagingEvidence: 'synthetic-staging', authenticationFiles: [], namespaceEvidence: 'synthetic-acl', nativeControlEvidence: null,
      network: { name: 'cq-s5-test', workerIP: '172.28.250.3', brokerIP: '172.28.250.2', port: 8080, brokerIdentity: 'c'.repeat(64), productionEligible: false } };
  }
  it('binds namespace, toolchain, mounts and broker identity without host mount escape options', () => {
    const spec = containerSpec();
    const policy = compileContainerBoundary(spec);
    expect(policy.createArgs).toContain('1000:1000');
    expect(policy.createArgs).toContain('--read-only');
    expect(policy.createArgs).toContain('ALL');
    expect(policy.createArgs).not.toContain('--privileged');
    expect(policy.createArgs.join(' ')).not.toContain('type=bind');
    expect(policy.heldOutEligible).toBe(false);
    expect(compileContainerBoundary({ ...spec, network: { ...spec.network, port: 8081 } }).identity).not.toBe(policy.identity);
    expect(() => compileContainerBoundary({ ...spec, image: 'node:latest' })).toThrow();
    expect(() => compileContainerBoundary({ ...spec, taskVolume: '/Users/ctaylor' })).toThrow();
    expect(() => compileContainerBoundary({ ...spec, network: { ...spec.network, brokerIP: '1.1.1.1' } })).toThrow();
  });
  it('refuses held-out, missing native admission and unbound live ACL receipts before exec', async () => {
    const boundary = compileContainerBoundary(containerSpec());
    let prepared = 0;
    const prepare = async () => { prepared++; return { containerId: 'd'.repeat(64), identity: 'wrong', aclVerified: true, dispose: async () => {} }; };
    const request = { boundary, executable: '/usr/local/bin/node', args: ['--version'], heldOut: false, purpose: 'no-model-probe' as const, prepare };
    await expect(spawnContainerBoundary({ ...request, heldOut: true })).rejects.toThrow(/G2/);
    await expect(spawnContainerBoundary({ ...request, purpose: 'actual-route' })).rejects.toThrow(/admission/);
    expect(prepared).toBe(0);
    await expect(spawnContainerBoundary(request)).rejects.toThrow(/ACL receipt/);
    expect(prepared).toBe(1);
  });
  it('rejects ambiguous TLS upstream inventory and makes synthetic trust ineligible', () => {
    const config = { timeoutMs: 1000, maxBodyBytes: 1024, routes: [{ id: 'declared', hostname: 'api.example.test',
      port: 443, pathPrefix: '/v1', methods: ['POST'], addresses: ['8.8.8.8'], requestHeaders: ['authorization', 'content-type'] }] };
    expect(compileBroker(config).productionEligible).toBe(true);
    expect(() => compileBroker({ ...config, routes: [{ ...config.routes[0], hostname: '*' }] })).toThrow();
    expect(() => compileBroker({ ...config, routes: [{ ...config.routes[0], addresses: ['127.0.0.1'] }] })).toThrow();
    expect(() => compileBroker({ ...config, routes: [{ ...config.routes[0], requestHeaders: ['host'] }] })).toThrow();
    expect(compileBroker({ ...config, synthetic: { ca: 'synthetic-only' } }).productionEligible).toBe(false);
  });
  it('rejects arbitrary CONNECT and absolute URLs through a real broker socket', async () => {
    const { server } = createEgressBroker({ routes: [], timeoutMs: 1000, maxBodyBytes: 1024 });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
    try {
      for (const line of ['CONNECT undeclared.test:443 HTTP/1.1', 'GET https://undeclared.test/ HTTP/1.1']) {
        const socket = (await import('node:net')).connect(address.port, '127.0.0.1');
        await once(socket, 'connect');
        const reply = new Promise<string>((resolve) => socket.once('data', (data) => resolve(data.toString())));
        socket.write(line + '\r\nHost: undeclared.test\r\nConnection: close\r\n\r\n');
        expect(await reply).toContain('403'); socket.destroy();
      }
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

describe('campaign boundary policy', () => {
  it('rejects blanket and overlapping read grants, including resolved symlinks', () => {
    const spec = fixture();
    expect(() => compileBoundary({ ...spec, toolchain: [{ path: homedir(), kind: 'tree', reason: 'dependencies' }] })).toThrow(/blanket/);
    expect(() => compileBoundary({ ...spec, toolchain: [{ path: spec.forbidden[0], kind: 'tree', reason: 'dependencies' }] })).toThrow(/overlaps/);
    symlinkSync(spec.forbidden[0], join(spec.bundle, 'escape'));
    expect(() => compileBoundary({ ...spec, toolchain: [{ path: join(spec.bundle, 'escape'), kind: 'tree', reason: 'deps' }] })).toThrow(/overlaps/);
    expect(() => compileBoundary({ ...spec, task: spec.bundle })).toThrow(/dedicated/);
    expect(() => compileBoundary({ ...spec, home: spec.context })).toThrow(/disjoint/);
    expect(() => compileBoundary({ ...spec, forbidden: [] })).toThrow(/declare/);
    expect(() => compileBoundary({ ...spec, authentication: [{ path: spec.home, reason: 'auth' }] })).toThrow(/exact files/);
  });

  it('records endpoint and extension controls in identity and fails closed on wildcard/DNS', () => {
    const spec = fixture();
    const base = compileBoundary(spec);
    const route = compileBoundary({ ...spec, endpoints: [{ address: '127.0.0.1', port: 8443, reason: 'declared route proxy' }] });
    expect(route.identity).not.toBe(base.identity);
    expect(route.profile).toContain('(remote ip "localhost:8443")');
    expect(base.profile).toContain('(deny default)');
    expect(base.profile).not.toContain('(allow network');
    expect(() => compileBoundary({ ...spec, endpoints: [{ address: 'example.test', port: 443, reason: 'route' }] })).toThrow(/localhost/);
    expect(() => compileBoundary({ ...spec, endpoints: [{ address: '0.0.0.0', port: 0, reason: 'route' }] })).toThrow(/localhost/);
    expect(compileBoundary({ ...spec, extensions: { mode: 'disabled', launchEvidence: 'native-control-artifact-sha' } }).identity).not.toBe(base.identity);
    expect(base.nativeControlsAttested).toBe(false);
    expect(base.environment.HOME).toBe(spec.home);
    expect(base.environment).not.toHaveProperty('OPENAI_API_KEY');
    expect(base.environment).not.toHaveProperty('NODE_OPTIONS');
  });

  it.runIf(process.platform === 'darwin')('requires admission and native-control evidence before actual-route spawn', async () => {
    const policy = compileBoundary(fixture());
    await expect(spawnBoundary({ policy, executable: process.execPath, args: ['--version'], purpose: 'actual-route' })).rejects.toThrow(/unverified/);
    const verified = compileBoundary({ ...policy.resolved, extensions: { mode: 'disabled', launchEvidence: 'verified-control-reference' } });
    await expect(spawnBoundary({ policy: verified, executable: process.execPath, args: ['--version'], purpose: 'actual-route' })).rejects.toThrow(/admission/);
    await expect(spawnBoundary({ policy: verified, executable: process.execPath, args: ['--version'], purpose: 'actual-route', heldOut: false, admit: async () => ({ admissionId: '' }) })).rejects.toThrow(/receipt/);
    await expect(spawnBoundary({ policy, executable: process.execPath, args: ['--version'], purpose: 'no-model-probe',
      bindings: { NODE_OPTIONS: '--require=ambient' }, bindingNames: ['NODE_OPTIONS'] })).rejects.toThrow(/safe name/);
  });

  it.runIf(process.platform === 'darwin')('rejects changed roots and undeclared executable before spawn', async () => {
    const policy = compileBoundary(fixture());
    await expect(spawnBoundary({ policy, executable: '/bin/sh', args: [], purpose: 'no-model-probe' })).rejects.toThrow(/undeclared/);
    rmSync(policy.resolved.context, { recursive: true });
    symlinkSync(policy.resolved.forbidden[0], policy.resolved.context);
    await expect(spawnBoundary({ policy, executable: process.execPath, args: [], purpose: 'no-model-probe' })).rejects.toThrow();
  });

  it.runIf(process.platform === 'darwin')('proves real executable/tool/shell/symlink/config/network behavior without establishing G2', async () => {
    const evidence = await probeHostBoundary();
    expect(evidence.blocker, JSON.stringify(evidence.checks)).toBeNull();
    expect(evidence.viable).toBe(true);
    expect(evidence.exitCode).toBe(0);
    expect(Object.keys(evidence.checks)).toHaveLength(18);
    expect(Object.values(evidence.checks).every(Boolean)).toBe(true);
    expect(evidence.g2).toBe('not-established');
    expect(evidence.resolved?.authentication).toEqual([]);
    expect(evidence.resolved?.endpoints).toEqual([]);
    expect(evidence.resolved?.toolchain).toEqual([]);
  }, 45_000);
});


describe('offline runtime and endpoint probes', () => {
  it.runIf(process.platform === 'darwin')('starts the installed executable for offline version only', async () => {
    const evidence = await probeNativeVersion({ label: 'node offline startup', executable: process.execPath });
    expect(evidence.viable).toBe(true);
    expect(evidence.version).toBe(process.versions.node);
    expect(evidence.g2).toBe('not-established');
  }, 20_000);

  it.runIf(process.platform === 'darwin')('permits exactly one declared service and denies a second local endpoint', async () => {
    const allowed = createServer((socket) => socket.end('declared-service'));
    const undeclared = createServer((socket) => socket.end('undeclared-service'));
    allowed.listen(0, '127.0.0.1'); undeclared.listen(0, '127.0.0.1');
    await Promise.all([once(allowed, 'listening'), once(undeclared, 'listening')]);
    const address = allowed.address(); const other = undeclared.address();
    if (!address || typeof address === 'string' || !other || typeof other === 'string') throw new Error('missing service port');
    try {
      const policy = compileBoundary({ ...fixture(), endpoints: [{ address: '127.0.0.1', port: address.port, reason: 'synthetic local service; no model calls' }] });
      // Exercise SBPL endpoint semantics directly: this is a synthetic socket test, not native admission.
      const script = `const net=require('node:net'); const allowed=net.connect({host:'127.0.0.1',port:${address.port}}); let data=''; allowed.on('data',x=>data+=x); allowed.on('end',()=>{const other=net.connect({host:'127.0.0.1',port:${other.port}}); other.on('error',e=>{console.log(JSON.stringify({allowed:data==='declared-service',denied:e.code==='EPERM'||e.code==='EACCES'}));});other.on('connect',()=>{console.log(JSON.stringify({allowed:true,denied:false}));other.destroy();});});allowed.on('error',()=>process.exit(2));`;
      const child = spawn('/usr/bin/sandbox-exec', ['-p', policy.profile, process.execPath, '-e', script], {
        cwd: policy.resolved.task, env: policy.environment, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      });
      let output = ''; child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); }); child.stderr.resume();
      const timer = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } } }, 15_000);
      try {
        const [code] = await once(child, 'close');
        expect(code).toBe(0);
        expect(JSON.parse(output)).toEqual({ allowed: true, denied: true });
      } finally { clearTimeout(timer); }
    } finally { allowed.close(); undeclared.close(); }
  }, 20_000);
});


describe('process argument isolation', () => {
  it.runIf(process.platform === 'darwin')('records the same-user process environment escape and refuses held-out launch', async () => {
    const spec = fixture();
    const source = join(spec.context, 'procargs.c');
    const executable = join(spec.context, 'procargs');
    writeFileSync(source, `#include <sys/types.h>
#include <sys/sysctl.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
int main(int argc,char **argv){int mib[]={CTL_KERN,KERN_PROCARGS2,atoi(argv[1])};size_t size=65536;char *buf=malloc(size);int status=sysctl(mib,3,buf,&size,NULL,0);int denied=status<0&&(errno==EPERM||errno==EACCES);int found=0;int argvfound=0;const char *sentinel="synthetic-hidden-environment";const char *argvsentinel="synthetic-hidden-argv";if(status==0){for(size_t i=0;i+strlen(sentinel)<size;i++){if(memcmp(buf+i,sentinel,strlen(sentinel))==0){found=1;}if(i+strlen(argvsentinel)<size&&memcmp(buf+i,argvsentinel,strlen(argvsentinel))==0){argvfound=1;}}}free(buf);return argc==3 ? (denied?0:(status<0?20+errno:(found&&argvfound?2:4))) : (status==0&&found&&argvfound?0:3);}`);
    const compiled = spawnSync('/usr/bin/cc', [source, '-o', executable], { timeout: 30_000, encoding: 'utf8' });
    expect(compiled.status, 'local C probe compilation must work').toBe(0);
    const hiddenProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'synthetic-hidden-argv'], { env: { SYNTHETIC_SENTINEL: 'synthetic-hidden-environment' }, stdio: 'ignore' });
    await once(hiddenProcess, 'spawn');
    try {
      const control = spawnSync(executable, [String(hiddenProcess.pid)], { timeout: 5000 });
      expect(control.status, 'unsandboxed seeded control must be readable').toBe(0);
      const policy = compileBoundary({ ...spec, executables: [executable] });
      const child = spawn('/usr/bin/sandbox-exec', ['-p', policy.profile, executable, String(hiddenProcess.pid), 'observe-side-channel'], {
        cwd: policy.resolved.task, env: policy.environment, stdio: 'ignore', detached: true,
      });
      const timer = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } } }, 10_000);
      try {
        const [code] = await once(child, 'close');
        expect(code, 'seeded environment is currently readable through the host kernel').toBe(2);
        expect(policy.heldOutEligible).toBe(false);
        await expect(spawnBoundary({ policy, executable, args: [], purpose: 'actual-route', heldOut: true })).rejects.toThrow(/process-argument isolation/);
      }
      finally { clearTimeout(timer); }
    } finally { hiddenProcess.kill('SIGKILL'); await once(hiddenProcess, 'close'); }
  }, 45_000);
});

// Staging/export operates on full private clones, never a diff through host paths.
describe('private task inventory and cleanup contract', () => {
  it('rejects hidden symlink targets and linked Git metadata before export writes', async () => {
    const { validateTaskEntries, materializeTask } = await import('../runner/boundary/task-tree.ts');
    const root = mkdtempSync(join(tmpdir(), 'cq-tree-test-')); roots.push(root);
    for (const target of ['/hidden/judge', '../sibling', '../../solution']) {
      expect(() => validateTaskEntries([{ path: 'escape', kind: 'symlink', mode: 0o777, target }], false, false)).toThrow(/symlink/);
    }
    expect(() => validateTaskEntries([{ path: '.git', kind: 'file', mode: 0o644, data: Buffer.from('gitdir: /hidden').toString('base64') }])).toThrow(/independent clone/);
    expect(() => materializeTask({ entries: [{ path: 'escape', kind: 'symlink', mode: 0o777, target: '/hidden' }], inventoryHash: '0'.repeat(64) }, root, false)).toThrow();
    expect((await import('node:fs')).readdirSync(root)).toEqual([]);
    expect(() => validateTaskEntries([{ path: 'mode', kind: 'file', mode: 0o4755, data: '' }], false, false)).toThrow(/unsafe task/);
    expect(() => validateTaskEntries([
      { path: 'a', kind: 'symlink', mode: 0o777, target: 'd/up/../hidden' },
      { path: 'd', kind: 'directory', mode: 0o755 },
      { path: 'd/up', kind: 'symlink', mode: 0o777, target: '..' },
    ], false, false)).toThrow(/chain escapes/);
  });
  it('preserves deletions, commits, untracked files and executable modes in a fresh clone', async () => {
    const { snapshotTask, materializeTask } = await import('../runner/boundary/task-tree.ts');
    const { verifyGitBaseline } = await import('../runner/boundary/task-staging.ts');
    const fs = await import('node:fs');
    const root = mkdtempSync(join(tmpdir(), 'cq-clone-test-')); roots.push(root);
    const source = join(root, 'source'); const destination = join(root, 'export'); mkdirSync(source); mkdirSync(destination);
    const git = (args: string[]) => { const r = spawnSync('/usr/bin/git', args, { cwd: source, encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }); expect(r.status, r.stderr).toBe(0); return r.stdout.trim(); };
    git(['init', '-q']); writeFileSync(join(source, 'deleted'), 'old'); git(['add', '.']);
    const commit = () => git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@invalid', 'commit', '-qm', 'synthetic']);
    commit(); const baseline = git(['rev-parse', 'HEAD']); fs.unlinkSync(join(source, 'deleted'));
    writeFileSync(join(source, 'executable'), 'candidate'); fs.chmodSync(join(source, 'executable'), 0o755); git(['add', '-A']); commit();
    writeFileSync(join(source, '.untracked'), 'partial'); symlinkSync('executable', join(source, 'safe-link'));
    const tree = snapshotTask(source, true); const audit = verifyGitBaseline(tree, baseline);
    expect(audit.head).not.toBe(baseline); materializeTask(tree, destination);
    expect(fs.existsSync(join(destination, 'deleted'))).toBe(false);
    expect(fs.readFileSync(join(destination, '.untracked'), 'utf8')).toBe('partial');
    expect(fs.lstatSync(join(destination, 'executable')).mode & 0o777).toBe(0o755);
    expect(fs.lstatSync(join(destination, 'safe-link')).isSymbolicLink()).toBe(true);
    expect(snapshotTask(destination).inventoryHash).toBe(tree.inventoryHash);
  }, 30_000);
  it('isolates Docker config and endpoint from ambient overrides', async () => {
    const { DockerControl } = await import('../runner/boundary/docker-control.ts');
    const { readFileSync } = await import('node:fs');
    const control = new DockerControl();
    try {
      expect(control.prefix).toEqual(['--config', control.configDirectory, '--host', `unix://${join(homedir(), '.colima/cq-boundary-s5/docker.sock')}`]);
      expect(readFileSync(join(control.configDirectory, 'config.json'), 'utf8').trim()).toBe('{}');
      expect(Object.keys(control.environment).sort()).toEqual(['HOME', 'LANG', 'PATH']);
      expect(control.configDirectory).not.toBe(join(homedir(), '.docker'));
    } finally { control.close(); }
  });
  it('rejects labels without private content inventory before preparing a worker', async () => {
    const { containerPreparer } = await import('../runner/boundary/container-prepare.ts');
    const specification: ContainerBoundarySpec = { profile: 'cq-boundary-s5', daemonId: 'dedicated', vmConfigHash: '0'.repeat(64), image: 'sha256:' + '1'.repeat(64), taskVolume: 'cq-s5-task-test', contextVolume: 'cq-s5-context-test', stagingEvidence: 'label-only', authenticationFiles: [], nativeControlEvidence: null, network: { name: 'cq-s5-net', workerIP: '172.30.5.3', brokerIP: '172.30.5.2', port: 8080, brokerIdentity: '2'.repeat(64), productionEligible: false }, namespaceEvidence: 'synthetic' };
    const policy = compileContainerBoundary(specification);
    await expect(containerPreparer(specification)(policy.createArgs, policy.identity)).rejects.toThrow(/private staging inventory/);
    for (const image of ['node:latest', '--config=/hidden', 'sha256:bad']) expect(() => compileContainerBoundary({ ...specification, image })).toThrow();
    expect(() => compileContainerBoundary({ ...specification, profile: 'other' as 'cq-boundary-s5' })).toThrow();
  });
});

describe('minimal managed subscription staging', () => {
  it('retains only managed OAuth fields and cannot switch to API-key auth', async () => {
    const { minimalCodexSubscription } = await import('../runner/boundary/subscription-auth.ts');
    const value = JSON.parse(minimalCodexSubscription({ auth_mode: 'chatgpt', OPENAI_API_KEY: 'synthetic-unused-key', tokens: { id_token: 'synthetic-id', access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', account_id: 'synthetic-account', extra: 'excluded' }, last_refresh: '2026-01-01T00:00:00Z', other: 'excluded' }));
    expect(value.auth_mode).toBe('chatgpt'); expect(value.OPENAI_API_KEY).toBeNull();
    expect(Object.keys(value.tokens).sort()).toEqual(['access_token', 'account_id', 'id_token', 'refresh_token']);
    expect(value.other).toBeUndefined(); expect(value.last_refresh).toBe('2026-01-01T00:00:00Z');
    expect(() => minimalCodexSubscription({ auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic' })).toThrow(/subscription/);
    expect(() => minimalCodexSubscription({ tokens: { access_token: 'partial' } })).toThrow(/fields unavailable/);
  });
});

describe('production broker exact endpoint contract', () => {
  it('rejects undeclared subpaths even when the parent prefix is allowed', async () => {
    const { server } = createEgressBroker({ routes: [{ id: 'catalog', hostname: 'chatgpt.com', port: 443, pathPrefix: '/backend-api/codex', exactPaths: ['/backend-api/codex/models'], methods: ['GET'], addresses: ['8.8.8.8'], requestHeaders: ['authorization'] }], timeoutMs: 1000, maxBodyBytes: 1024 });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
    try {
      const status = await new Promise<number>((resolve, reject) => {
        (import('node:http')).then(({ get }) => get(`http://127.0.0.1:${address.port}/route/catalog/backend-api/codex/models/undeclared`, (response) => { response.resume(); resolve(response.statusCode!); }).on('error', reject), reject);
      });
      expect(status).toBe(403);
      expect(() => compileBroker({ routes: [{ id: 'catalog', hostname: 'chatgpt.com', port: 443, pathPrefix: '/models', exactPaths: ['/oauth/token'], methods: ['GET'], addresses: ['8.8.8.8'], requestHeaders: [] }], timeoutMs: 1000, maxBodyBytes: 1024 })).toThrow();
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it('pipes synthetic TLS SSE chunks before the upstream finishes', async () => {
    const fs = await import('node:fs'); const https = await import('node:https'); const http = await import('node:http');
    const root = mkdtempSync(join(tmpdir(), 'cq-sse-test-')); roots.push(root);
    const key = join(root, 'key.pem'); const cert = join(root, 'cert.pem');
    const generated = spawnSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=upstream.synthetic.test', '-addext', 'subjectAltName=DNS:upstream.synthetic.test'], { timeout: 10_000, stdio: 'ignore' });
    expect(generated.status).toBe(0);
    let finishUpstream: (() => void) | undefined;
    const upstream = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_req, response) => {
      if (_req.url === '/responses?redirect=1') { response.writeHead(302, { location: 'https://unauthorized.invalid/secret' }); response.end(); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: synthetic-first\n\n');
      finishUpstream = () => response.end('data: synthetic-last\n\n');
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const target = upstream.address(); if (!target || typeof target === 'string') throw new Error('missing target port');
    const { server } = createEgressBroker({ routes: [{ id: 'synthetic', hostname: 'upstream.synthetic.test', port: target.port, pathPrefix: '/responses', exactPaths: ['/responses'], methods: ['GET'], addresses: ['127.0.0.1'], requestHeaders: [] }], synthetic: { ca: fs.readFileSync(cert, 'utf8') }, timeoutMs: 10_000, maxBodyBytes: 1024 });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing broker port');
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http.get(`http://127.0.0.1:${address.port}/route/synthetic/responses`, (response) => {
          let data = ''; response.on('data', (chunk) => { data += chunk; if (data.includes('synthetic-first') && finishUpstream) { const finish = finishUpstream; finishUpstream = undefined; finish(); } });
          response.once('end', () => resolve(data)); response.once('error', reject);
        }).once('error', reject);
      });
      expect(body).toContain('synthetic-first'); expect(body).toContain('synthetic-last');
      const redirectStatus = await new Promise<number>((resolve, reject) => { http.get(`http://127.0.0.1:${address.port}/route/synthetic/responses?redirect=1`, (res) => { res.resume(); resolve(res.statusCode!); }).on('error', reject); });
      expect(redirectStatus).toBe(502);
    } finally { finishUpstream?.(); await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]); }
  }, 30_000);
});


describe('access-only final profile', () => {
  it('drops refresh authority and rejects insufficient expiry budgets', async () => {
    const { accessOnlyCodexSubscription } = await import('../runner/boundary/subscription-auth.ts');
    const now = 1700000000000;
    const input = { tokens: { id_token: 'synthetic-id', access_token: 'x.' + Buffer.from(JSON.stringify({ exp: now / 1000 + 2000 })).toString('base64url') + '.x', refresh_token: 'never-stage', account_id: 'synthetic-account' } };
    const result = JSON.parse(accessOnlyCodexSubscription(input, 900, now));
    expect(result.auth_mode).toBe('chatgptAuthTokens'); expect(result.tokens.refresh_token).toBe('');
    expect(JSON.stringify(result)).not.toContain('never-stage');
    expect(() => accessOnlyCodexSubscription(input, 900, now + 1000000)).toThrow(/expiry budget/);
  });
  it('denies wrong endpoint methods, refresh, encoded paths and undeclared routes', async () => {
    const { server } = createEgressBroker({ routes: [{ id: 'codex', hostname: 'chatgpt.com', port: 443, pathPrefix: '/backend-api/codex', exactPaths: ['/backend-api/codex/models', '/backend-api/codex/responses'], endpointMethods: { '/backend-api/codex/models': ['GET'], '/backend-api/codex/responses': ['POST'] }, methods: ['GET', 'POST'], addresses: ['8.8.8.8'], requestHeaders: [] }], timeoutMs: 1000, maxBodyBytes: 1024 });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
    if (!address || typeof address === 'string') throw new Error('port');
    const { request } = await import('node:http');
    try {
      for (const [method, path] of [['POST', '/route/codex/backend-api/codex/models'], ['GET', '/route/codex/backend-api/codex/responses'], ['POST', '/route/refresh/oauth/token'], ['GET', '/route/codex/backend-api/codex/models%2fsecret'], ['GET', '/route/other/backend-api/codex/models']]) {
        const status = await new Promise<number>((resolve, reject) => { const req = request({ hostname: '127.0.0.1', port: address.port, path, method }, (res) => { res.resume(); resolve(res.statusCode!); }); req.on('error', reject); req.end(); });
        expect(status).toBe(403);
      }
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
