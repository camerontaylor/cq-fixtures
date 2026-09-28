import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import dns from 'node:dns/promises';
import http from 'node:http';

const hidden = JSON.parse(process.env.SYNTHETIC_PATHS);
const absent = (path) => { try { fs.readFileSync(path); return false; } catch (e) { return ['ENOENT', 'EACCES', 'EPERM'].includes(e.code); } };
const results = {};
results.authorizedContext = fs.readFileSync('/context/authorized.txt', 'utf8') === 'visible context';
fs.writeFileSync('/task/result.txt', 'task write');
results.authorizedTaskWrite = fs.readFileSync('/task/result.txt', 'utf8') === 'task write';
try { fs.writeFileSync('/context/forbidden-write', 'x'); results.contextReadOnly = false; } catch (e) { results.contextReadOnly = ['EROFS', 'EACCES'].includes(e.code); }
for (const [name, path] of Object.entries(hidden)) {
  results[`${name}Direct`] = absent(path);
  const link = `/task/escape-${name}`;
  fs.symlinkSync(path, link);
  results[`${name}Symlink`] = absent(link);
  const shell = spawnSync('/bin/sh', ['-c', 'cat "$1" >/dev/null 2>&1; test $? -ne 0', 'probe', path]);
  results[`${name}ShellChild`] = shell.status === 0;
  const child = spawnSync('/usr/local/bin/node', ['-e', 'try{require("fs").readFileSync(process.argv[1]);process.exit(2)}catch(e){process.exit(["ENOENT","EACCES","EPERM"].includes(e.code)?0:3)}', path]);
  results[`${name}ToolChild`] = child.status === 0;
}
results.dockerSocketAbsent = !fs.existsSync('/var/run/docker.sock') && !fs.existsSync('/run/containerd/containerd.sock');
results.hostHomeAbsent = !fs.existsSync('/Users/ctaylor') && !fs.existsSync('/host');
results.cleanHome = process.env.HOME === '/home/worker' && !fs.existsSync('/home/worker/.codex/auth.json') && !fs.existsSync('/home/worker/.pi/agent/auth.json');
results.uidNonRoot = process.getuid() === 1000;
results.noCapabilities = /^CapEff:\s+0+$/m.test(fs.readFileSync('/proc/self/status', 'utf8'));
results.noNewPrivileges = /^NoNewPrivs:\s+1$/m.test(fs.readFileSync('/proc/self/status', 'utf8'));
results.seccompEnabled = /^Seccomp:\s+2$/m.test(fs.readFileSync('/proc/self/status', 'utf8'));
let exposed = false;
for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
  for (const name of ['cmdline', 'environ']) {
    try {
      const value = fs.readFileSync(`/proc/${pid}/${name}`, 'utf8');
      if (value.includes('cq-hidden-process-argv') || value.includes('cq-hidden-process-environment')) exposed = true;
    } catch { /* Inaccessible or vanished process is not a leak. */ }
  }
}
results.externalProcessSentinelsAbsent = !exposed;
results.privatePidNamespace = process.pid !== Number(process.env.VM_SIBLING_PID) && !fs.existsSync(`/proc/${process.env.VM_SIBLING_PID}`);
function blocked(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(650); socket.on('connect', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(true)); socket.on('timeout', () => { socket.destroy(); resolve(true); });
  });
}
for (const [name, host, port] of [
  ['directSyntheticUpstream', '172.28.250.4', 8443],
  ['brokerWrongPort', '172.28.250.2', 8081],
  ['vmGateway', '172.28.250.1', 22],
  ['externalEndpoint', '1.1.1.1', 443],
  ['dockerDnsTcp', '127.0.0.11', 53],
  ['ipv6Loopback', '::1', 8080],
]) results[name + 'Denied'] = await blocked(host, port);
try { await Promise.race([dns.resolve4('example.com'), new Promise((_, reject) => setTimeout(() => reject(new Error('bounded DNS')), 800))]); results.dnsDenied = false; } catch { results.dnsDenied = true; }
const embedded = new dns.Resolver({ timeout: 500, tries: 1 });
embedded.setServers(['127.0.0.11']);
try { await embedded.resolve4('example.com'); results.embeddedDnsUdpDenied = false; } catch { results.embeddedDnsUdpDenied = true; }
function request(path, method = 'GET') {
  return new Promise((resolve) => {
    const req = http.request({ host: '172.28.250.2', port: 8080, path, method, timeout: 3000 }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('error', () => resolve(0)); req.on('timeout', () => req.destroy()); req.end();
  });
}
results.allowedTlsRoute = await request('/route/synthetic/v1/ok') === 200;
results.redirectDenied = await request('/route/synthetic/v1/redirect') === 502;
results.undeclaredRouteDenied = await request('/route/undeclared/v1/ok') === 403;
results.absoluteUrlDenied = await request('https://undeclared.test/v1/ok') === 403;
results.pathEscapeDenied = await request('/route/synthetic/v1/%2e%2e/escape') === 403;
results.connectDenied = await request('undeclared.test:443', 'CONNECT') === 403;
results.badTlsHostnameDenied = await request('/route/bad-tls/v1/ok') === 502;
console.log(JSON.stringify({ checks: results, allPassed: Object.values(results).every(Boolean), modelCalls: 0, g2: 'not-established' }));
process.exit(Object.values(results).every(Boolean) ? 0 : 1);
