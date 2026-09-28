/** Explicit operator invocation only. NO turns, generations, login or real refresh.
 * Public output is fixed-schema booleans/status/counts; child output never emitted.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { DockerControl, teardownContainer } from './docker-control.ts';
import { privateCodexAuthContext } from './subscription-auth.ts';
import { resolveBrokerHost, compileBroker } from './egress-broker.ts';

const HTTP_ONLY = process.argv[2] === 'http-only';
if (process.argv[2] && !HTTP_ONLY) throw new Error('only declared http-only qualification variant allowed');
const RUNTIME = 'sha256:2a9422f0de75079fd81da5a5b68bf9936e72ce22e30d1a22ddd91bc77201de4e';
const control = new DockerControl(); const token = randomBytes(8).toString('hex');
const network = 'cq-s5-subscription-' + token; const volume = 'cq-s5-auth-' + token;
const image = 'cq-s5-subscription-broker:' + token; const build = mkdtempSync(join(tmpdir(), 'cq-s5-subscription-build-'));
const containers: string[] = []; let createdNetwork = false; let createdVolume = false;
const evidence: Record<string, unknown> = { modelTurns: 0, generationRoutes: 0, actualRefreshExchangePerformed: false, refreshEndpointAllowed: false, httpOnlyCustomProvider: HTTP_ONLY, g2: 'blocked', runtimeImage: RUNTIME };
const begin = Date.now();
try {
  evidence.phase = 'minimal-auth-context';
  const privateContext = privateCodexAuthContext();
  // Auth hash and content stay in private parent context, never this public result.
  evidence.privateContextStaged = true; evidence.privateContextDirectory = privateContext.directory; evidence.authFileMode = '0600';
  await control.run(['volume', 'create', '--label', 'cq.boundary.subscription=private', volume]); createdVolume = true;
  const io = readFileSync(new URL('./volume-io.mjs', import.meta.url), 'utf8');
  await control.utility(['--rm', '-i', '--pull=never', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges', '--memory', '384m', '--cpus', '0.5', '--pids-limit', '32', '--mount', `type=volume,source=${volume},target=/task,volume-nocopy`, '--entrypoint', '/usr/local/bin/node', RUNTIME, '-e', io, 'write'], JSON.stringify([{ path: 'auth.json', kind: 'file', mode: 0o600, data: Buffer.from(privateContext.auth).toString('base64') }]));
  const inventory = await control.utility(['--rm', '--pull=never', '--network', 'none', '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '384m', '--cpus', '0.5', '--pids-limit', '32', '--mount', `type=volume,source=${volume},target=/context,readonly,volume-nocopy`, '--entrypoint', '/usr/local/bin/node', RUNTIME, '-e', "const fs=require('fs');console.log(JSON.stringify({hash:require('crypto').createHash('sha256').update(fs.readFileSync('/context/auth.json')).digest('hex'),mode:fs.statSync('/context/auth.json').mode&511}))"]);
  const verified = JSON.parse(inventory);
  if (verified.hash !== createHash('sha256').update(privateContext.auth).digest('hex') || verified.mode !== 0o600) throw new Error('private auth inventory mismatch');
  evidence.authInventoryVerified = true; evidence.phase = 'offline-login-status';
  const offline = await control.utility(['--rm', '--pull=never', '--network', 'none', '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '384m', '--cpus', '0.5', '--pids-limit', '32', '--mount', `type=volume,source=${volume},target=/context,readonly,volume-nocopy`, '--env', 'CODEX_HOME=/context', '--env', 'HOME=/nonexistent', '--entrypoint', '/usr/local/bin/node', RUNTIME, '-e', "const r=require('child_process').spawnSync('/usr/local/bin/codex',['login','status'],{timeout:10000,encoding:'utf8'});console.log(JSON.stringify({exitCode:r.status,subscriptionRecognized:/ChatGPT/i.test(r.stdout+r.stderr),apiKeyRecognized:/API key/i.test(r.stdout+r.stderr)}))"]);
  evidence.offlineLogin = JSON.parse(offline);
  evidence.phase = 'fixed-host-dns-and-broker-build';
  const addresses = await resolveBrokerHost('chatgpt.com');
  const config = { routes: [{ id: 'catalog', hostname: 'chatgpt.com', port: 443, pathPrefix: '/backend-api/codex/models', exactPaths: ['/backend-api/codex/models'], methods: ['GET'], addresses, requestHeaders: ['authorization', 'chatgpt-account-id', 'openai-beta', 'originator', 'user-agent', 'accept', 'version'] }], timeoutMs: 10_000, maxBodyBytes: 1024 };
  evidence.brokerIdentity = compileBroker(config).identity; evidence.dnsPinned = true;
  writeFileSync(join(build, 'broker.js'), readFileSync(new URL('../../dist/boundary/egress-broker.js', import.meta.url), 'utf8'));
  writeFileSync(join(build, 'config.json'), JSON.stringify(config));
  writeFileSync(join(build, 'main.mjs'), `import {readFileSync} from 'node:fs';import {createEgressBroker} from './broker.js';const {server}=createEgressBroker(JSON.parse(readFileSync('/opt/config.json')));server.on('request',(req,res)=>{const allowed=req.url?.split('?')[0]==='/route/catalog/backend-api/codex/models';res.on('finish',()=>console.log(JSON.stringify({event:'metadata',allowedPath:allowed,method:req.method==='GET'?'GET':'other',bearerAttached:typeof req.headers.authorization==='string'&&req.headers.authorization.startsWith('Bearer '),accountHeaderAttached:typeof req.headers['chatgpt-account-id']==='string',status:res.statusCode})));});server.listen(8080,'0.0.0.0');`);
  writeFileSync(join(build, 'Dockerfile'), `FROM ${RUNTIME}\nCOPY broker.js config.json main.mjs /opt/\nENTRYPOINT ["/usr/local/bin/node","/opt/main.mjs"]\n`);
  await control.run(['build', '--network=none', '-t', image, build]);
  const brokerImage = await control.run(['image', 'inspect', image, '--format', '{{.Id}}']); evidence.brokerImage = brokerImage;
  await control.run(['network', 'create', '--internal', '--subnet', '172.29.249.0/24', '--label', 'cq.boundary.subscription=private', network]); createdNetwork = true;
  const broker = await control.run(['create', '--pull=never', '--network', network, '--ip', '172.29.249.2', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '384m', '--cpus', '0.5', '--pids-limit', '32', brokerImage]); containers.push(broker);
  // Only trusted broker gets VM egress. Worker has sole internal namespace network.
  await control.run(['network', 'connect', 'bridge', broker]); await control.run(['start', broker]);
  const nativeConfig = HTTP_ONLY ? 'model_provider="cq-subscription-http"\ncli_auth_credentials_store="file"\n[model_providers.cq-subscription-http]\nname="CQ subscription HTTP qualification"\nbase_url="http://172.29.249.2:8080/route/catalog/backend-api/codex"\nwire_api="responses"\nrequires_openai_auth=true\nsupports_websockets=false\n' : 'openai_base_url="http://172.29.249.2:8080/route/catalog/backend-api/codex"\ncli_auth_credentials_store="file"\n';
  const wrapper = `const fs=require('fs');fs.mkdirSync('/home/worker/.codex',{mode:448,recursive:true});fs.copyFileSync('/context/auth.json','/home/worker/.codex/auth.json');fs.chmodSync('/home/worker/.codex/auth.json',384);fs.writeFileSync('/home/worker/.codex/config.toml',${JSON.stringify(nativeConfig)});const r=require('child_process').spawnSync('/usr/local/bin/codex',['debug','models'],{timeout:15000,encoding:'utf8',maxBuffer:8388608});let parsed=false;try{JSON.parse(r.stdout);parsed=true}catch{};console.log(JSON.stringify({exitCode:r.status,jsonCatalog:parsed,timedOut:r.error?.code==='ETIMEDOUT',diagnostics:{config:/config/i.test(r.stderr),unknownField:/unknown field|unrecognized|unknown configuration/i.test(r.stderr),permissions:/permission denied|read-only file/i.test(r.stderr),network:/connect|fetch|request|network/i.test(r.stderr),auth:/auth|login|token/i.test(r.stderr),invalidValue:/invalid|expected/i.test(r.stderr)},diagnosticFlags:['unknown fields','unrecognized keys','strict','trust','provider','feedback','analytics','check_for_update_on_startup','directory','toml','syntax','features','Unsupported'].filter(x=>r.stderr.toLowerCase().includes(x.toLowerCase())),safeUnknownFields:[...r.stderr.matchAll(/unknown field \x60([a-z_]+)\x60/g)].map(x=>x[1]).filter(x=>['openai_base_url','cli_auth_credentials_store','check_for_update_on_startup','analytics','feedback','model_provider','model_providers','supports_websockets','requires_openai_auth'].includes(x))}));`;
  const worker = await control.run(['create', '--pull=never', '--network', network, '--ip', '172.29.249.3', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '768m', '--cpus', '1', '--pids-limit', '64', '--tmpfs', '/home/worker:rw,nosuid,nodev,noexec,uid=1000,gid=1000,size=32m', '--tmpfs', '/tmp:rw,nosuid,nodev,uid=1000,gid=1000,size=32m', '--mount', `type=volume,source=${volume},target=/context,readonly,volume-nocopy`, '--env', 'HOME=/home/worker', '--env', 'CODEX_HOME=/home/worker/.codex', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin', '--entrypoint', '/usr/local/bin/node', RUNTIME, '-e', 'setInterval(()=>{},10000)']); containers.push(worker);
  evidence.phase = 'worker-namespace-acl';
  await control.run(['start', worker]);
  const workerState = JSON.parse(await control.run(['inspect', worker]))[0];
  const acl = readFileSync(new URL('./namespace-acl.sh', import.meta.url), 'utf8');
  const rules = execFileSync('/usr/local/bin/colima', ['-p', 'cq-boundary-s5', 'ssh', '--', 'sudo', 'sh', '-c', acl, 'cq-subscription-acl', String(workerState.State.Pid), '172.29.249.2', '8080'], { env: control.environment, timeout: 15000, maxBuffer: 128 * 1024, encoding: 'utf8' });
  if ((rules.match(/:OUTPUT DROP/g) ?? []).length !== 2 || !rules.includes('-d 172.29.249.2/32') || !rules.includes('--dport 8080')) throw new Error('worker ACL unverified');
  evidence.workerDNSDenied = true; evidence.workerEgressBrokerOnly = true;
  evidence.phase = 'authenticated-read-only-catalog';
  const result = await control.run(['exec', worker, '/usr/local/bin/node', '-e', wrapper]); evidence.metadataCommand = JSON.parse(result);
  const events = (await control.run(['logs', broker])).split('\n').filter(Boolean).map((line) => JSON.parse(line)); evidence.brokerEvents = events;
  evidence.phase = 'complete';
  evidence.authenticatedMetadataAccepted = events.some((e) => e.allowedPath && e.bearerAttached && e.accountHeaderAttached && e.status === 200);
} catch { evidence.qualificationFailed = true; evidence.error = 'bounded qualification operation failed; no child output disclosed'; }
finally {
  for (const id of containers.reverse()) await teardownContainer(control, id);
  if (createdNetwork) await control.run(['network', 'rm', network]);
  if (createdVolume) await control.run(['volume', 'rm', volume]);
  try { await control.run(['image', 'rm', image]); } catch { /* absent image or retained content-qualified cache */ }
  control.close(); rmSync(build, { recursive: true, force: true });
  evidence.seconds = (Date.now() - begin) / 1000;
  console.log(JSON.stringify(evidence));
}
