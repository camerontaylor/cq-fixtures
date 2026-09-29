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

describe('final native container admission and argument boundary', () => {
  it('requires a distinct stage, profile, invocation and unexpired parent receipt', async () => {
    const { validateFinalAdmission } = await import('../runner/boundary/codex-final-profile.ts');
    const expected = { stage: 'final-profile-G1' as const, boundaryIdentity: 'boundary', invocationIdentity: 'invocation' };
    const receipt = { ...expected, admissionId: 'parent-final-profile-1', profile: 'cq-subscription-http' as const, expiresAt: 10000, heldOut: false as const };
    expect(() => validateFinalAdmission(receipt, expected, 1000)).not.toThrow();
    for (const changed of [{ stage: 'actual-route-G2' }, { profile: 'host-visible' }, { invocationIdentity: 'other' }, { expiresAt: 999 }, { heldOut: true }]) {
      expect(() => validateFinalAdmission({ ...receipt, ...changed } as typeof receipt, expected, 1000)).toThrow(/distinct final-profile/);
    }
  });
  it('maps only the exact declared native invocation to frozen provider controls', async () => {
    const { finalCodexArguments } = await import('../runner/boundary/codex-final-profile.ts');
    const args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', 'danger-full-access', '-C', '/synthetic/task', '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort="low"', '-'];
    const actual = finalCodexArguments(args, '/synthetic/task');
    expect(actual[7]).toBe('/task'); expect(actual).toContain('--ignore-user-config');
    expect(actual).toContain('model_providers.cq-subscription-http.requires_openai_auth=true');
    expect(actual).toContain('model_providers.cq-subscription-http.supports_websockets=false');
    expect(() => finalCodexArguments([...args, '-c', 'model_provider="escaped"'], '/synthetic/task')).toThrow();
    expect(() => finalCodexArguments(args, '/other/task')).toThrow();
  });
  it('rechecks private access-only expiry and forbids refresh authority', async () => {
    const { validateFinalCodexAuth } = await import('../runner/boundary/codex-final-profile.ts');
    const now = 1700000000000;
    const jwt = 'x.' + Buffer.from(JSON.stringify({ exp: now / 1000 + 1200 })).toString('base64url') + '.x';
    const auth = { auth_mode: 'chatgptAuthTokens', OPENAI_API_KEY: null, tokens: { access_token: jwt, id_token: jwt, account_id: 'synthetic', refresh_token: '' } };
    expect(() => validateFinalCodexAuth(JSON.stringify(auth), 900, now)).not.toThrow();
    expect(() => validateFinalCodexAuth(JSON.stringify(auth), 900, now + 300000)).toThrow(/expiry/);
    auth.tokens.refresh_token = 'shared-synthetic';
    expect(() => validateFinalCodexAuth(JSON.stringify(auth), 900, now)).toThrow(/access-only/);
  });
});

describe('final container lifecycle failure and exit races', () => {
  it('stops an already-exited child and preserves the first stop error', async () => {
    const { finalContainerLifecycle } = await import('../runner/boundary/codex-final-profile.ts');
    const { EventEmitter } = await import('node:events');
    const child = Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null });
    const error = new Error('first synthetic termination failure'); let stops = 0; let exports = 0; let closed = 0;
    const lifecycle = finalContainerLifecycle({ child, budgetSeconds: 900, terminate: async () => { stops++; throw error; }, exportTask: async () => { exports++; }, cleanup: async () => {}, closeControl: () => { closed++; throw new Error('later synthetic control-close failure'); } });
    await expect(lifecycle.terminate()).rejects.toBe(error);
    await expect(lifecycle.finalize()).rejects.toBe(error);
    expect(stops).toBe(1); expect(exports).toBe(0); expect(closed).toBe(1);
  });
  it('closes trusted control after export failure and skips volume cleanup', async () => {
    const { finalContainerLifecycle } = await import('../runner/boundary/codex-final-profile.ts');
    const { EventEmitter } = await import('node:events');
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
    const error = new Error('synthetic unsafe export'); const events: string[] = [];
    const lifecycle = finalContainerLifecycle({ child, budgetSeconds: 900, terminate: async () => { events.push('stop'); }, exportTask: async () => { events.push('export'); throw error; }, cleanup: async () => { events.push('remove-volumes'); }, closeControl: () => { events.push('close-control'); } });
    await expect(lifecycle.finalize()).rejects.toBe(error);
    expect(events).toEqual(['stop', 'export', 'close-control']);
  });
  it('closes trusted control on cleanup failure and retains that original error', async () => {
    const { finalContainerLifecycle } = await import('../runner/boundary/codex-final-profile.ts');
    const { EventEmitter } = await import('node:events');
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
    const error = new Error('synthetic volume ownership failure'); let closed = 0;
    const lifecycle = finalContainerLifecycle({ child, budgetSeconds: 900, terminate: async () => {}, exportTask: async () => 'partial-export', cleanup: async () => { throw error; }, closeControl: () => { closed++; } });
    await expect(lifecycle.finalize()).rejects.toBe(error); expect(closed).toBe(1);
  });
});


it('rejects alternate content-pinned workers before staging or admission', async () => {
  const { createFinalCodexSpawnAdapter } = await import('../runner/boundary/codex-final-profile.ts');
  for (const image of ['sha256:' + 'f'.repeat(64), 'node:latest']) {
    const input = { specification: { image } } as Parameters<typeof createFinalCodexSpawnAdapter>[0];
    expect(() => createFinalCodexSpawnAdapter(input)).toThrow(/hard-pinned final native worker/);
  }
});

describe('G2 harness synthetic evidence cannot grant actual qualification', () => {
  async function sample() {
    const h = await import('../runner/boundary/g2-harness.ts');
    const pins = await import('../runner/boundary/codex-final-profile.ts');
    const fixture = h.createG2Fixture(); roots.push(fixture.privateRoot);
    const exportRoot = mkdtempSync(join(tmpdir(), 'cq-g2-export-test-')); roots.push(exportRoot);
    writeFileSync(join(exportRoot, '.g2-partial'), 'CQ_G2_PUBLIC_TASK_CONTROL', { mode: 0o700 });
    const traces = fixture.probes.map(probe => ({ invocationId: 'synthetic-invocation', probeId: probe.id, channel: probe.channel, target: probe.target, requestedCommand: probe.command, attempted: true, disposition: probe.expected === 'deny' ? 'denied' as const : 'success' as const, denialKind: (probe.channel === 'native-config' ? 'config-inventory-verified' : ['process-argv', 'process-env'].includes(probe.channel) ? 'guardian-not-visible' : ['shell-network', 'native-network'].includes(probe.channel) ? 'broker-403' : 'not-found') as import('../runner/boundary/g2-harness.ts').G2NativeTrace['denialKind'], exitCode: 0, httpStatus: 403, toolErrorCode: 'ENOENT' as const, controlProof: { kind: (probe.channel === 'native-config' ? 'native-inventory-verified' : 'guardian-namespace-absent') as 'native-inventory-verified' | 'guardian-namespace-absent', verified: true as const }, output: Buffer.from(probe.expected === 'deny' ? 'synthetic denial' : 'CQ_G2_PUBLIC_TASK_CONTROL'), complete: true }));
    const result: import('../runner/boundary/g2-harness.ts').G2NativeResult = { invocationId: 'synthetic-invocation', boundaryIdentity: 'synthetic-boundary', launchIdentity: 'synthetic-launch', provenance: 'synthetic', admissionId: 'synthetic-admission', stage: 'actual-route-G2', profile: 'cq-subscription-http', workerImage: pins.FINAL_NATIVE_IMAGE, brokerImage: pins.FINAL_BROKER_IMAGE, brokerIdentity: pins.FINAL_BROKER_IDENTITY, configHash: pins.FINAL_CODEX_CONFIG_HASH, traces, rawOutputs: [], workerAbsentVerified: true, teardownAwaited: true, baselineVerified: true, exportRoot, timedOutOrCancelled: true, childTreeStopped: true, actualResponsesStreamObserved: true, nativeInventoryComplete: true };
    return { h, fixture, result };
  }
  it('requires every actual channel and never trusts fabricated complete evidence', async () => {
    const { h, fixture, result } = await sample();
    const report = h.evaluateG2(fixture, result); expect(report.channelsComplete).toBe(true); expect(report.qualified).toBe(false);
    expect(JSON.stringify(report)).not.toContain(fixture.values.judge);
    result.traces = result.traces.filter(t => t.channel !== 'native-network');
    expect(h.evaluateG2(fixture, result).rows.filter(r => r.channel === 'native-network').every(r => r.traceUnavailable)).toBe(true);
    expect(h.evaluateG2(fixture, result).channelsComplete).toBe(false);
  });
  it('detects sentinel bytes split across chunks and encoded in exported data', async () => {
    const { h, fixture, result } = await sample(); const secret = fixture.values.solution;
    result.rawOutputs = [Buffer.from(secret.slice(0, 12)), Buffer.from(secret.slice(12))];
    expect(h.evaluateG2(fixture, result).sentinelDetected).toBe(true);
    result.rawOutputs = []; writeFileSync(join(result.exportRoot, 'leak'), Buffer.from(secret).toString('base64'));
    expect(h.evaluateG2(fixture, result).sentinelDetected).toBe(true);
  });
  it('rejects duplicate, mismatched-command and incomplete trace claims', async () => {
    const { h, fixture, result } = await sample();
    result.traces.push(result.traces[0]); result.traces[1].complete = false;
    const child = result.traces.find(t => t.channel === 'shell-child')!; child.requestedCommand = 'model prose substituted shell';
    const rows = h.evaluateG2(fixture, result).rows;
    expect(rows.find(r => r.id === fixture.probes[0].id)?.traceUnavailable).toBe(true);
    expect(rows.find(r => r.id === child.probeId)?.traceUnavailable).toBe(true);
  });
  it('refuses typed denial claims without actual status or control corroboration', async () => {
    const { h, fixture, result } = await sample();
    for (const trace of result.traces) { delete trace.httpStatus; delete trace.exitCode; delete trace.toolErrorCode; delete trace.controlProof; trace.output = Buffer.alloc(0); }
    const rows = h.evaluateG2(fixture, result).rows;
    expect(rows.filter(r => fixture.probes.find(p => p.id === r.id)?.expected === 'deny').every(r => !r.denied)).toBe(true);
    const trace = result.traces.find(t => t.channel === 'native-network')!;
    trace.output = Buffer.from('claimed HTTP 403');
    expect(h.evaluateG2(fixture, result).rows.find(r => r.id === trace.probeId)?.denied).toBe(false);
    trace.httpStatus = 403;
    expect(h.evaluateG2(fixture, result).rows.find(r => r.id === trace.probeId)?.denied).toBe(true);
  });
  it('qualifies only through consumed admission and exact independent stopped-export audit', async () => {
    const { h, fixture, result } = await sample();
    const { FINAL_BROKER_RUNTIME_IDENTITY } = await import('../runner/boundary/broker-toolchain.ts');
    const tree = await import('../runner/boundary/task-tree.ts');
    const git = (args: string[]) => { const r = spawnSync('/usr/bin/git', args, { cwd: result.exportRoot, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: result.exportRoot, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, timeout: 5000 }); if (r.status !== 0) throw new Error('synthetic Git fixture'); return r.stdout.trim(); };
    git(['init','-q']); git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','add','.']); git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','baseline']);
    const baselineCommit = git(['rev-parse','HEAD']);
    // Independent snapshot strips local fixture config before hashing, as production staging does.
    const normalized = tree.snapshotTask(result.exportRoot, true);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(result.exportRoot,'.git/config'), Buffer.from(normalized.entries.find(e => e.path === '.git/config')!.data!, 'base64'));
    const expected = { inventoryHash: tree.snapshotTask(result.exportRoot, false).inventoryHash, head: baselineCommit, baselineCommit };
    fixture.guardian = { containerId: 'synthetic-test-only', volume: 'synthetic-test-only', daemonId: 'synthetic-test-only', image: result.workerImage };
    Object.assign(result, { provenance: 'actual-native', effectiveBrokerIdentity: FINAL_BROKER_RUNTIME_IDENTITY, postExportCandidateExecutionProtected: true, oracleCallerAdapted: true, receiptExport: { inventoryHash: expected.inventoryHash, head: expected.head } });
    result.admissionId = 'junk-admission';
    expect(h.evaluateG2(fixture, result).qualified).toBe(false);
    const input = { finalG1EvidenceAccepted: true, admissionId: result.admissionId, timeoutMs: 10000, execute: async () => result, stop: async () => {}, verifyConsumedAdmission: async () => true, verifyStoppedExport: async () => expected };
    await expect(h.runG2Harness(fixture, { ...input, verifyConsumedAdmission: async () => false })).rejects.toThrow(/unavailable/);
    expect((await h.runG2Harness(fixture, input)).qualified).toBe(true);
    result.receiptExport!.inventoryHash = '0'.repeat(64);
    expect((await h.runG2Harness(fixture, input)).exportIdentityVerified).toBe(false);
    result.receiptExport!.inventoryHash = expected.inventoryHash; result.receiptExport!.head = '0'.repeat(40);
    expect((await h.runG2Harness(fixture, input)).qualified).toBe(false);
    result.receiptExport!.head = expected.head;
    writeFileSync(join(result.exportRoot, 'changed-after-audit'), 'synthetic');
    expect((await h.runG2Harness(fixture, input)).qualified).toBe(false);
  });
  it('keeps bounded cause classification private without copying secret-bearing messages', async () => {
    const { h, fixture, result } = await sample();
    fixture.guardian = { containerId: 'synthetic', volume: 'synthetic', daemonId: 'synthetic', image: result.workerImage };
    let stopped = false;
    await expect(h.runG2Harness(fixture, { finalG1EvidenceAccepted: true, admissionId: 'synthetic-admission', timeoutMs: 1000, execute: async () => { throw Object.assign(new Error(fixture.values.judge), { code: 'EACCES' }); }, stop: async () => { stopped = true; }, verifyConsumedAdmission: async () => false, verifyStoppedExport: async () => { throw new Error(); } })).rejects.toThrow('G2 execution/evidence unavailable');
    const fs = await import('node:fs'); const paths = fs.readdirSync(fixture.privateRoot).filter(p => p.startsWith('failure-'));
    expect(stopped).toBe(true); expect(paths.length).toBe(1);
    const path = join(fixture.privateRoot, paths[0]), content = fs.readFileSync(path, 'utf8');
    expect(content).not.toContain(fixture.values.judge); expect(JSON.parse(content)).toMatchObject({ phase: 'native-execution', errorClass: 'Error', code: 'EACCES' }); expect(fs.statSync(path).mode & 0o777).toBe(0o600);
  });
  it('blocks invocation without final G1/guardian before any native callback', async () => {
    const { h, fixture } = await sample(); let called = false;
    await expect(h.runG2Harness(fixture, { finalG1EvidenceAccepted: false, admissionId: 'not-admitted', timeoutMs: 1000, execute: async () => { called = true; throw new Error(); }, stop: async () => {}, verifyConsumedAdmission: async () => false, verifyStoppedExport: async () => { throw new Error('no export'); } })).rejects.toThrow(/final G1/);
    expect(called).toBe(false);
  });
});

describe('protected judge child input boundary', () => {
  it('permits bounded behavioral calls but rejects traversal, huge inputs and excessive deadlines', async () => {
    const { validateJudgeChildRequest } = await import('../runner/boundary/judge-child.ts');
    const request = { candidateRoot: '/synthetic', module: 'src/product.mjs', exportName: 'behavior', requests: [['public input']], timeoutMs: 1000 };
    expect(JSON.parse(validateJudgeChildRequest(request)).requests).toEqual([['public input']]);
    for (const changed of [{ module: '../judge.mjs' }, { module: '/hidden/reference.js' }, { requests: [['x'.repeat(70000)]] }, { timeoutMs: 16000 }]) expect(() => validateJudgeChildRequest({ ...request, ...changed })).toThrow();
  });
});

it('does not normalize missing canonical tool outcomes into denial', async () => {
  const h = await import('../runner/boundary/g2-harness.ts');
  const fixture = h.createG2Fixture(); roots.push(fixture.privateRoot);
  const probe = fixture.probes[0];
  const receipt: import('../runner/boundary/g2-harness.ts').G2CanonicalNativeReceipt = {
    identity: { assignmentId: 'synthetic', stageId: 'G2', attemptId: 'one', invocationId: 'synthetic' },
    launch: { boundaryIdentity: 'synthetic', launchIdentity: 'synthetic', admissionId: 'synthetic' }, terminal: { state: 'exit' },
    teardown: { processTree: 'stopped-and-reaped', boundary: 'terminated', export: { inventoryHash: 'a'.repeat(64), head: 'b'.repeat(40) } },
    toolTrace: ['start', 'result'].map((phase, i) => ({ eventId: String(i), invocationId: 'synthetic', phase: phase as 'start' | 'result', kind: 'read' as const, targetOrCommand: probe.target, correlationId: 'pair' })),
  };
  const result = h.normalizeG2NativeReceipt(fixture, receipt, {} as Parameters<typeof h.normalizeG2NativeReceipt>[2]);
  expect(result.receiptExport).toEqual({ inventoryHash: 'a'.repeat(64), head: 'b'.repeat(40) });
  expect(result.traces[0].attempted).toBe(true); expect(result.traces[0].complete).toBe(false); expect(result.traces[0].disposition).toBe('unavailable');
});

describe('stopped candidate publication into exact runSuite workspace', () => {
  async function publicationFixture() {
    const fs = await import('node:fs'); const { createHash } = await import('node:crypto');
    const tree = await import('../runner/boundary/task-tree.ts'); const stage = await import('../runner/boundary/task-staging.ts');
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'cq-publication-test-'))); roots.push(parent); fs.chmodSync(parent, 0o700);
    const source = join(parent, 'assigned'); mkdirSync(source); writeFileSync(join(source, 'tracked'), 'original'); writeFileSync(join(source, 'deleted'), 'remove me');
    const git = (cwd: string, args: string[]) => { const r = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: parent, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, timeout: 5000 }); if (r.status !== 0) throw new Error('synthetic fixture Git failed'); return r.stdout.trim(); };
    git(source, ['init', '-q']); git(source, ['config', 'user.name', 'Synthetic']); git(source, ['config', 'user.email', 'synthetic@example.invalid']); git(source, ['add', '.']); git(source, ['commit', '-qm', 'baseline']);
    const baselineCommit = git(source, ['rev-parse', 'HEAD']), task = tree.snapshotTask(source, true);
    const context = tree.validateTaskEntries([], false, false);
    const receipt = { daemonId: 'synthetic', utilityImage: 'sha256:' + '1'.repeat(64), taskVolume: 'cq-s5-task-' + '1'.repeat(16), contextVolume: 'cq-s5-context-' + '1'.repeat(16), baselineCommit, taskIdentity: tree.taskIdentity(task, baselineCommit), task, context, receiptHash: '' };
    receipt.receiptHash = createHash('sha256').update(JSON.stringify({ daemonId: receipt.daemonId, utilityImage: receipt.utilityImage, taskVolume: receipt.taskVolume, contextVolume: receipt.contextVolume, baselineCommit, taskIdentity: receipt.taskIdentity, taskInventory: task.inventoryHash, contextInventory: context.inventoryHash })).digest('hex');
    const exported = mkdtempSync(join(parent, '.cq-stopped-export-')); tree.materializeTask(task, exported);
    return { fs, tree, stage, parent, source, exported, receipt, git, proof: () => ({ inventoryHash: tree.snapshotTask(exported, false).inventoryHash, head: git(exported, ['rev-parse', 'HEAD']), namespaceAbsent: true as const }) };
  }
  it('publishes committed edits, deletions, untracked files and executable modes while retaining rollback original', async () => {
    const f = await publicationFixture(); writeFileSync(join(f.exported, 'tracked'), 'candidate'); f.fs.unlinkSync(join(f.exported, 'deleted')); f.git(f.exported, ['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qam','candidate']);
    writeFileSync(join(f.exported, 'untracked'), 'partial', { mode: 0o700 }); const expectedHead = f.proof().head;
    const receipt = f.stage.publishStoppedTask(f.receipt, f.exported, f.source, f.proof());
    expect(f.fs.readFileSync(join(f.source, 'tracked'), 'utf8')).toBe('candidate'); expect(f.fs.existsSync(join(f.source, 'deleted'))).toBe(false); expect(f.fs.statSync(join(f.source, 'untracked')).mode & 0o777).toBe(0o700); expect(f.git(f.source, ['rev-parse', 'HEAD'])).toBe(expectedHead);
    expect(receipt.destination).toBe(f.source); expect(receipt.baselineCommit).toBe(f.receipt.baselineCommit); expect(receipt.baselineTree).toBe(f.git(f.source, ['rev-parse', f.receipt.baselineCommit + '^{tree}'])); expect(receipt.hostUnchanged && receipt.afterTeardown && receipt.captureEligible).toBe(true);
    expect(f.fs.readFileSync(join(receipt.backupRoot, 'tracked'), 'utf8')).toBe('original'); expect(f.fs.statSync(receipt.recoveryManifest).mode & 0o777).toBe(0o600);
  });
  it('refuses mutated pristine task, export identity mismatch and traversal alias', async () => {
    const f = await publicationFixture(); const proof = f.proof();
    expect(() => f.stage.publishStoppedTask(f.receipt, f.exported, f.source, { ...proof, inventoryHash: 'f'.repeat(64) })).toThrow(/identity/);
    expect(() => f.stage.publishStoppedTask(f.receipt, f.exported, f.source + '/.', proof)).toThrow(/canonical/);
    writeFileSync(join(f.source, 'tracked'), 'host mutation'); expect(() => f.stage.publishStoppedTask(f.receipt, f.exported, f.source, proof)).toThrow(/pristine/);
    expect(f.fs.readFileSync(join(f.source, 'tracked'), 'utf8')).toBe('host mutation'); expect(f.fs.existsSync(f.exported)).toBe(true);
  });
  it('refuses symlink ancestors without replacing the original', async () => {
    const f = await publicationFixture(); const alias = join(f.parent, 'alias'); symlinkSync(f.parent, alias);
    expect(() => f.stage.publishStoppedTask(f.receipt, join(alias, f.exported.split('/').at(-1)!), f.source, f.proof())).toThrow(/canonical|symlink/); expect(f.fs.existsSync(f.source)).toBe(true);
  });
  it('retains the original backup when both candidate publication and rollback rename fail', async () => {
    const f = await publicationFixture(); let calls = 0;
    expect(() => f.stage.publishStoppedTask(f.receipt, f.exported, f.source, f.proof(), (from, to) => { if (++calls >= 2) throw new Error('synthetic filesystem failure'); f.fs.renameSync(from, to); })).toThrow(/private hashed recovery/);
    const backup = f.fs.readdirSync(f.parent).find(name => name.startsWith('assigned.cq-original-'))!;
    expect(f.fs.readFileSync(join(f.parent, backup, 'tracked'), 'utf8')).toBe('original'); expect(f.fs.existsSync(f.exported)).toBe(true);
  });
  it('refuses a writable shared parent directory', async () => {
    const f = await publicationFixture(); f.fs.chmodSync(f.parent, 0o777);
    expect(() => f.stage.publishStoppedTask(f.receipt, f.exported, f.source, f.proof())).toThrow(/parent-owned/);
    f.fs.chmodSync(f.parent, 0o700); expect(f.fs.existsSync(f.source)).toBe(true);
  });
  it('rolls back a failed candidate rename and retains the complete exported candidate', async () => {
    const f = await publicationFixture(); let calls = 0;
    expect(() => f.stage.publishStoppedTask(f.receipt, f.exported, f.source, f.proof(), (from, to) => { if (++calls === 2) throw new Error('synthetic rename failure'); f.fs.renameSync(from, to); })).toThrow(/private hashed recovery/);
    expect(f.fs.readFileSync(join(f.source, 'tracked'), 'utf8')).toBe('original'); expect(f.fs.existsSync(f.exported)).toBe(true); const manifest = f.fs.readdirSync(f.parent).find(name => name.startsWith(f.exported.split('/').at(-1)! + '.recovery-'))!; expect(JSON.parse(f.fs.readFileSync(join(f.parent, manifest), 'utf8')).state).toBe('rolled-back');
  });
});

describe('exclusive public broker toolchain', () => {
  async function fixture() {
    const b = await import('../runner/boundary/broker-toolchain.ts');
    const volumeName = 'cq-s5-broker-assets-' + 'a'.repeat(16), runId = 'synthetic-runtime';
    return { b, input: { runId, volumeName, liveInventory: b.brokerAssetTree(), volume: { Driver: 'local', Options: null, Labels: { 'cq.boundary.runtime': runId, 'cq.boundary.public-assets': b.FINAL_BROKER_ASSET_INVENTORY } }, broker: { Image: 'sha256:a0af04214c67a25e4c5ab01b20f6e6deea98fc664b65ae5532576949234adfe3', Config: { User: '1000:1000', Entrypoint: ['/usr/local/bin/node'], Cmd: ['/opt/broker.mjs','/opt/config.json'], Labels: { 'cq.boundary.runtime': runId, 'cq.boundary.broker-runtime': b.FINAL_BROKER_RUNTIME_IDENTITY } }, HostConfig: { ReadonlyRootfs: true, Privileged: false, PidMode: '', CapDrop: ['ALL'], CapAdd: null, Binds: null, PortBindings: null }, Mounts: [{ Type: 'volume', Name: volumeName, Destination: '/opt', RW: false }] } } };
  }
  it('accepts exact public files and rejects altered bytes despite matching ownership labels', async () => {
    const { b, input } = await fixture(); b.validateLiveBrokerToolchain(input);
    const tree = await import('../runner/boundary/task-tree.ts');
    input.liveInventory = tree.validateTaskEntries(input.liveInventory.entries.map(e => ({ ...e, data: Buffer.from('synthetic replacement').toString('base64') })), false, false);
    expect(() => b.validateLiveBrokerToolchain(input)).toThrow(/assets/);
  });
  it('rejects writable, redirected, and additional auth mounts', async () => {
    for (const mutation of ['writable','redirected','auth']) {
      const { b, input } = await fixture();
      if (mutation === 'writable') input.broker.Mounts[0].RW = true;
      if (mutation === 'redirected') input.broker.Mounts[0].Destination = '/different';
      if (mutation === 'auth') input.broker.Mounts.push({ Type: 'volume', Name: 'private-auth', Destination: '/auth', RW: false });
      expect(() => b.validateLiveBrokerToolchain(input)).toThrow(/toolchain/);
    }
  });
  it('rejects image, user, command and exclusive label substitutions', async () => {
    for (const mutation of ['image','user','command','label']) {
      const { b, input } = await fixture();
      if (mutation === 'image') input.broker.Image = 'sha256:' + '0'.repeat(64);
      if (mutation === 'user') input.broker.Config.User = '0:0';
      if (mutation === 'command') input.broker.Config.Cmd.push('--extra');
      if (mutation === 'label') input.volume.Labels['cq.boundary.public-assets'] = '0'.repeat(64);
      expect(() => b.validateLiveBrokerToolchain(input)).toThrow(/toolchain/);
    }
  });
});

it('private G1 factory leaves quota telemetry to the authenticated native default', async () => {
  const { createHash } = await import('node:crypto');
  const { fileURLToPath } = await import('node:url');
  const privateRoot = mkdtempSync(join(tmpdir(), 'cq-runtime-quota-test-')); roots.push(privateRoot);
  const plan = { repoRoot: process.cwd(), privateRoot, privateAuthRoot: join(privateRoot,'synthetic-auth'), network: 'synthetic-network', brokerContainerId: 'synthetic-broker', runId: 'synthetic-quota-test' };
  writeFileSync(join(privateRoot,'setup-state.json'), JSON.stringify({ authRoot: plan.privateAuthRoot, network: plan.network, broker: { containerId: plan.brokerContainerId } }), { mode: 0o600 });
  writeFileSync(join(privateRoot,'plan-hash.json'), JSON.stringify({ sha256: createHash('sha256').update(JSON.stringify(plan)).digest('hex') }), { mode: 0o600 });
  const factory = fileURLToPath(new URL('../runner/boundary/final-g1-runtime.mjs', import.meta.url));
  const script = "const m=await import(process.argv[1]);const runtime=await m.createPreparedFinalG1Runtime(JSON.parse(process.argv[2]),{verify:false});console.log(JSON.stringify({quotaOverride:Object.hasOwn(runtime.options,'quotaSource'),prepare:typeof runtime.options.prepareInvocation,cleanup:typeof runtime.options.cleanupInvocation}))";
  const child = spawnSync(process.execPath, ['--experimental-transform-types','--input-type=module','-e',script,factory,JSON.stringify(plan)], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  expect(child.status).toBe(0); expect(JSON.parse(child.stdout)).toEqual({ quotaOverride: false, prepare: 'function', cleanup: 'function' });
}, 20000);

it('records timer stop failure and memoized finalization without secret messages', async () => {
  const { finalContainerLifecycle } = await import('../runner/boundary/codex-final-profile.ts');
  const { privateLifecycleRecorder } = await import('../runner/boundary/lifecycle-evidence.ts');
  const { EventEmitter } = await import('node:events');
  const { readFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'cq-private-lifecycle-test-'));
  const file = join(root, 'events.jsonl'); writeFileSync(file, '', { mode:0o600 });
  try {
    const child = Object.assign(new EventEmitter(), { exitCode:null, signalCode:null });
    const error = Object.assign(new Error('PRIVATE_SYNTHETIC_CREDENTIAL'), { code:'EPERM' });
    let stopCalls = 0; let exported = false;
    let started!: () => void; const timerFired = new Promise<void>(r => { started = r; });
    const record = privateLifecycleRecorder(file);
    const life = finalContainerLifecycle({ child, budgetSeconds:0.01,
      terminate:async()=>{stopCalls++; started(); throw error;}, exportTask:async()=>{exported=true;},cleanup:async()=>{},closeControl:()=>{},record });
    await timerFired;
    await expect(life.terminate()).rejects.toBe(error);
    await expect(life.finalize()).rejects.toBe(error);
    const raw=readFileSync(file,'utf8');const rows=raw.trim().split('\n').map(line=>JSON.parse(line));
    expect(raw).not.toContain('PRIVATE_SYNTHETIC_CREDENTIAL');
    expect(rows.map(r=>r.phase).filter(phase=>phase!=='terminate-reused')).toEqual(['trigger-timer','terminate-start','terminate-error','finalize-start','finalize-error','control-close']);
    expect(rows.filter(r=>r.phase==='terminate-reused')).toHaveLength(2);
    expect(rows.find(r=>r.phase==='terminate-error')).toMatchObject({errorClass:'Error',code:'EPERM'});
    expect(stopCalls).toBe(1);expect(exported).toBe(false);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

it('refuses redirected private phase evidence and retains only Docker operation metadata', async () => {
  const { privateLifecycleRecorder } = await import('../runner/boundary/lifecycle-evidence.ts');
  const { readFileSync } = await import('node:fs');
  const root=mkdtempSync(join(tmpdir(),'cq-private-phase-test-'));
  try {
    const file=join(root,'events');writeFileSync(file,'',{mode:0o600});
    const alias=join(root,'alias');symlinkSync(file,alias);
    expect(()=>privateLifecycleRecorder(alias)('terminate-start')).toThrow();
    const record=privateLifecycleRecorder(file);
    record('session-stop-error',new Error('bounded Docker operation failed (inspect, 1)'));
    record('finalize-error',new Error('PRIVATE_SYNTHETIC_OUTPUT'));
    const raw=readFileSync(file,'utf8');const rows=raw.trim().split('\n').map(line=>JSON.parse(line));
    expect(rows[0]).toMatchObject({phase:'session-stop-error',operation:'inspect',exitCode:1});
    expect(rows[1]).not.toHaveProperty('operation');expect(raw).not.toContain('PRIVATE_SYNTHETIC_OUTPUT');
  } finally {rmSync(root,{recursive:true,force:true});}
});

// Explicit opt-in uses only the dedicated pinned S5 daemon, synthetic task/context
// and network-none worker. It never loads subscription auth or a native model.
describe.skipIf(process.env.CQ_BOUNDARY_SYNTHETIC_DAEMON !== '1')('actual private factory abort ownership', () => {
  it.each(['abort', 'control', 'setup-abort'])('preserves ordered cleanup for %s', async mode => {
    const { fileURLToPath } = await import('node:url');
    const probe = fileURLToPath(new URL('../runner/boundary/probe-runtime-abort.mjs', import.meta.url));
    const child = spawnSync(process.execPath, ['--experimental-transform-types', probe, mode], {
      encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024,
    });
    expect(child.status).toBe(0);
    const proof = JSON.parse(child.stdout);
    expect(proof.modelCalls).toBe(0);
    expect(proof.actualRouteQualified).toBe(false);
    if (mode === 'setup-abort') {
      expect(proof.setupRejected).toBe(true);
      expect(proof.cleanupAwaited).toBe(true);
      expect(proof.handedOff).toBe(false);
    } else {
      expect(proof.finalizeFailed).toBe(false);
      expect(proof.competingRuntimeRemoval).toBe(false);
      expect(proof.exportPresent).toBe(true);
      expect(proof.publicationVerified).toBe(true);
      expect(proof.namespaceAbsent).toBe(true);
      expect(proof.recoveryPreserved).toBe(true);
      expect(proof.events.indexOf('runtime-worker-lookup')).toBeGreaterThan(proof.events.indexOf('adapter-finalization-settled'));
    }
  }, 95000);
});
