#!/usr/bin/env python3
"""Bounded synthetic-only VM/container qualification. Never copy auth or host trees.
Creates exclusively cq-s5-* objects on the dedicated daemon, and removes only
objects created by this invocation. No model calls or public listeners.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
EVIDENCE = HERE / 'evidence' / 'fallback'
BASE = 'node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6'
DOCKER = ['docker', '--context', 'colima-cq-boundary-s5']
COLIMA = ['colima', '-p', 'cq-boundary-s5', 'ssh', '--']
created = {'containers': [], 'volumes': [], 'networks': []}
timings = []


def run(args, timeout=30, input=None, label=None):
    begin = time.monotonic()
    p = subprocess.run(args, input=input, capture_output=True, text=True, timeout=timeout)
    timings.append({'operation': label or args[0], 'seconds': round(time.monotonic()-begin, 2), 'exitCode': p.returncode})
    if p.returncode:
        raise RuntimeError((label or args[0])+': '+p.stderr[-1600:]+p.stdout[-1000:])
    return p.stdout.strip()


def docker(*args, **kwargs):
    return run(DOCKER+list(args), **kwargs)


def create(kind, name, *args):
    # Refuse existing objects; never modify or replace another run's resources.
    probe = subprocess.run(DOCKER+[kind, 'inspect', name] if kind != 'container' else DOCKER+['inspect', name], capture_output=True)
    if probe.returncode == 0:
        raise RuntimeError('refusing existing '+kind+' '+name)
    if kind == 'container':
        value = docker('create', '--name', name, *args)
    else:
        value = docker(kind, 'create', *args, name)
    created[{'container': 'containers', 'volume': 'volumes', 'network': 'networks'}[kind]].append(name)
    return value


def hardening(network, ip=None):
    args = ['--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--memory', '256m', '--memory-swap', '256m', '--cpus', '0.5', '--pids-limit', '64',
            '--cgroupns', 'private', '--ipc', 'private', '--network', network, '--dns', '127.0.0.1',
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m,uid=1000,gid=1000']
    if ip:
        args += ['--ip', ip]
    return args


def main():
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    begin = time.monotonic()
    result = {'g2': 'not-established', 'modelCalls': 0, 'profile': 'cq-boundary-s5'}
    host_helper = None
    vm_hidden_created = False
    try:
        config = Path.home()/'.colima/_lima/colima-cq-boundary-s5/lima.yaml'
        text = config.read_text()
        if '\nmounts:' in text or 'forwardAgent: true' in text:
            raise RuntimeError('unexpected host mounts or agent forwarding')
        result['vmConfigHash'] = hashlib.sha256(config.read_bytes()).hexdigest()
        result['daemonId'] = docker('info', '--format', '{{.ID}}')
        result['guest'] = run(COLIMA+['sh', '-c', 'uname -sr; findmnt -rn -o TARGET,FSTYPE; df -h / /var/lib/docker'], label='guest inventory')
        with tempfile.TemporaryDirectory(prefix='cq-s5-synthetic-') as root:
            root = Path(root)
            hidden = root/'hidden'; hidden.mkdir()
            for name in ['judge', 'solution', 'sibling', 'ambient-config']:
                (hidden/name).write_text('synthetic hidden '+name)
            host_helper = subprocess.Popen(['node', '-e', 'setInterval(()=>{},10000)', 'cq-hidden-process-argv'],
                                           env={'PATH': os.environ.get('PATH', ''), 'CQ_SYNTHETIC_ENV': 'cq-hidden-process-environment'},
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            # A separate container supplies positive controls for process and sibling-file sentinels.
            sibling = create('container', 'cq-s5-sentinel', *hardening('none'),
                             '--env', 'CQ_SYNTHETIC_ENV=cq-hidden-process-environment', BASE,
                             'node', '-e', 'require("fs").writeFileSync("/tmp/hidden-sibling","synthetic sibling");setInterval(()=>{},10000)', 'cq-hidden-process-argv')
            docker('start', sibling)
            control = docker('exec', sibling, 'node', '-e', 'const f=require("fs");console.log(JSON.stringify({argv:f.readFileSync("/proc/1/cmdline","utf8").includes("cq-hidden-process-argv"),env:f.readFileSync("/proc/1/environ","utf8").includes("cq-hidden-process-environment"),file:f.readFileSync("/tmp/hidden-sibling","utf8")==="synthetic sibling"}))')
            result['positiveControls'] = json.loads(control)
            sibling_pid = json.loads(docker('inspect', sibling))[0]['State']['Pid']
            # VM-only sentinels, never mounted in a worker.
            run(COLIMA+['sh', '-s'], input='set -eu\n[ ! -e /tmp/cq-s5-hidden ]\nmkdir /tmp/cq-s5-hidden\nprintf synthetic-judge > /tmp/cq-s5-hidden/judge\nprintf synthetic-solution > /tmp/cq-s5-hidden/solution\nprintf synthetic-config > /tmp/cq-s5-hidden/config\n', label='VM synthetic staging')
            vm_hidden_created = True
            create('network', 'cq-s5-probe', '--internal', '--subnet', '172.28.250.0/24')
            context = root/'image'; context.mkdir()
            (context/'authorized.txt').write_text('visible context')
            (context/'seed.txt').write_text('visible task')
            (context/'gate.mjs').write_text('setInterval(()=>{},10000);\n')
            (context/'container-probe.mjs').write_bytes((HERE/'container-probe.mjs').read_bytes())
            (context/'Dockerfile').write_text(f'FROM {BASE}\nUSER root\nRUN mkdir -p /task /context /home/worker && chown -R 1000:1000 /task /context /home/worker\nCOPY --chown=1000:1000 authorized.txt gate.mjs container-probe.mjs /context/\nCOPY --chown=1000:1000 seed.txt /task/\nUSER 1000:1000\n')
            docker('build', '--network', 'none', '-t', 'cq-s5-worker-probe:local', str(context), timeout=90, label='worker image build')
            worker_image = docker('image', 'inspect', 'cq-s5-worker-probe:local', '--format', '{{.Id}}')
            result['workerImageId'] = worker_image
            create('volume', 'cq-s5-task-probe', '--label', 'cq.boundary.staging=cq-s5-synthetic-staging-v1', '--label', 'cq.boundary.kind=task')
            create('volume', 'cq-s5-context-probe', '--label', 'cq.boundary.staging=cq-s5-synthetic-staging-v1', '--label', 'cq.boundary.kind=context')
            # TLS synthetic upstream has its own key; worker image never contains it.
            tls = root/'tls'; tls.mkdir()
            run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=synthetic.test',
                 '-addext', 'subjectAltName=DNS:synthetic.test', '-keyout', str(tls/'key.pem'), '-out', str(tls/'cert.pem')], label='synthetic certificate')
            (tls/'server.mjs').write_text('import https from "node:https";import fs from "node:fs";https.createServer({key:fs.readFileSync("/opt/key.pem"),cert:fs.readFileSync("/opt/cert.pem")},(q,s)=>{if(q.url==="/v1/redirect"){s.writeHead(302,{location:"https://undeclared.test/hidden"});s.end()}else{s.writeHead(200);s.end("synthetic authorized")}}).listen(8443,"0.0.0.0");\n')
            (tls/'Dockerfile').write_text(f'FROM {BASE}\nCOPY --chown=1000:1000 key.pem cert.pem server.mjs /opt/\nUSER 1000:1000\n')
            docker('build', '--network', 'none', '-t', 'cq-s5-upstream-probe:local', str(tls), timeout=90, label='synthetic upstream build')
            upstream = create('container', 'cq-s5-upstream-probe', *hardening('cq-s5-probe', '172.28.250.4'), 'cq-s5-upstream-probe:local', 'node', '/opt/server.mjs')
            docker('start', upstream)
            broker_dir = root/'broker'; broker_dir.mkdir()
            broker_config = {'routes': [{'id': name, 'hostname': host, 'port': 8443, 'pathPrefix': '/v1', 'methods': ['GET'],
                                         'addresses': ['172.28.250.4'], 'requestHeaders': ['content-type']} for name, host in [('synthetic', 'synthetic.test'), ('bad-tls', 'bad.synthetic.test')]],
                             'timeoutMs': 3000, 'maxBodyBytes': 1048576, 'synthetic': {'ca': (tls/'cert.pem').read_text()}}
            (broker_dir/'config.json').write_text(json.dumps(broker_config))
            (broker_dir/'egress-broker.ts').write_bytes((HERE/'egress-broker.ts').read_bytes())
            (broker_dir/'Dockerfile').write_text(f'FROM {BASE}\nCOPY --chown=1000:1000 config.json egress-broker.ts /opt/\nUSER 1000:1000\n')
            docker('build', '--network', 'none', '-t', 'cq-s5-broker-probe:local', str(broker_dir), timeout=90, label='broker build')
            broker = create('container', 'cq-s5-broker-probe', *hardening('cq-s5-probe', '172.28.250.2'), 'cq-s5-broker-probe:local', 'node', '/opt/egress-broker.ts', '/opt/config.json')
            docker('start', broker)
            broker_policy = docker('exec', broker, 'node', '--input-type=module', '-e', 'import {compileBroker} from "/opt/egress-broker.ts";import fs from "node:fs";const p=compileBroker(JSON.parse(fs.readFileSync("/opt/config.json")));console.log(JSON.stringify({identity:p.identity,productionEligible:p.productionEligible}))')
            result['broker'] = json.loads(broker_policy)
            # Known existing paths outside the mount and process namespaces.
            paths = {'hostJudge': str(hidden/'judge'), 'hostSolution': str(hidden/'solution'), 'hostSibling': str(hidden/'sibling'),
                     'hostConfig': str(hidden/'ambient-config'), 'vmJudge': '/tmp/cq-s5-hidden/judge',
                     'vmSolution': '/tmp/cq-s5-hidden/solution', 'vmConfig': '/tmp/cq-s5-hidden/config',
                     'siblingRoot': f'/proc/{sibling_pid}/root/tmp/hidden-sibling'}
            worker = create('container', 'cq-s5-worker-probe', *hardening('cq-s5-probe', '172.28.250.3'),
                            '--workdir', '/task', '--mount', 'type=volume,source=cq-s5-task-probe,target=/task',
                            '--mount', 'type=volume,source=cq-s5-context-probe,target=/context,readonly',
                            '--tmpfs', '/home/worker:rw,nosuid,nodev,noexec,size=32m,uid=1000,gid=1000',
                            '--env', 'HOME=/home/worker', '--env', 'XDG_CONFIG_HOME=/home/worker/.config',
                            '--env', 'SYNTHETIC_PATHS='+json.dumps(paths), '--env', 'VM_SIBLING_PID='+str(sibling_pid),
                            'cq-s5-worker-probe:local', 'node', '/context/gate.mjs')
            docker('start', worker)
            worker_inspect = json.loads(docker('inspect', worker))[0]
            worker_pid = worker_inspect['State']['Pid']
            rules = run(COLIMA+['sudo', 'sh', '-s', '--', str(worker_pid), '172.28.250.2', '8080'],
                        input=(HERE/'namespace-acl.sh').read_text(), label='install namespace ACL')
            (EVIDENCE/'namespace-acl.rules').write_text(rules+'\n')
            result['namespaceAclHash'] = hashlib.sha256(rules.encode()).hexdigest()
            result['workerContainerId'] = worker
            result['workerNamespace'] = {key: worker_inspect['HostConfig'].get(key) for key in
                                         ['Privileged', 'ReadonlyRootfs', 'CapDrop', 'SecurityOpt', 'PidMode', 'IpcMode', 'NetworkMode', 'Memory', 'NanoCpus', 'PidsLimit', 'PortBindings']}
            result['mounts'] = [{k: m.get(k) for k in ['Type', 'Name', 'Destination', 'RW']} for m in worker_inspect['Mounts']]
            output = docker('exec', '--user', '1000:1000', worker, 'node', '/context/container-probe.mjs', timeout=40, label='actual container probes')
            result.update(json.loads(output))
            assert all(result['positiveControls'].values()), 'synthetic positive control missing'
            assert result['allPassed'], 'container probe failure'
            # End the synthetic worker before reusing its task volume for a fresh,
            # harmless live adapter verification. No concurrent task-volume sharing.
            docker('rm', '-f', worker)
            created['containers'].remove('cq-s5-worker-probe')
            spec = {'profile': 'cq-boundary-s5', 'daemonId': result['daemonId'], 'vmConfigHash': result['vmConfigHash'],
                    'image': worker_image, 'taskVolume': 'cq-s5-task-probe', 'contextVolume': 'cq-s5-context-probe',
                    'stagingEvidence': 'cq-s5-synthetic-staging-v1', 'authenticationFiles': [], 'nativeControlEvidence': None,
                    'namespaceEvidence': 'synthetic-readback-v1',
                    'network': {'name': 'cq-s5-probe', 'workerIP': '172.28.250.3', 'brokerIP': '172.28.250.2',
                                'port': 8080, 'brokerIdentity': result['broker']['identity'], 'productionEligible': False}}
            # Invoke the actual TypeScript preparer, not a stand-in receipt.
            adapter_code = f'''import {{compileContainerBoundary}} from {json.dumps((HERE/'container.ts').as_uri())};
import {{containerPreparer}} from {json.dumps((HERE/'container-prepare.ts').as_uri())};
import {{readFileSync}} from 'node:fs';import {{execFileSync}} from 'node:child_process';
const spec=JSON.parse(readFileSync(0,'utf8'));const p=compileContainerBoundary(spec);
const r=await containerPreparer(spec)(p.createArgs,p.identity);
try{{const v=execFileSync('/usr/local/bin/docker',['--host','unix://'+process.env.HOME+'/.colima/cq-boundary-s5/docker.sock','exec',r.containerId,'node','--version'],{{timeout:15000,encoding:'utf8'}}).trim();
console.log(JSON.stringify({{identity:r.identity,containerId:r.containerId,aclVerified:r.aclVerified,aclHash:r.aclHash,nodeVersion:v}}));}}finally{{await r.dispose();}}
'''
            adapter = run(['node', '--input-type=module', '-e', adapter_code], input=json.dumps(spec), timeout=90, label='live TypeScript prepare adapter')
            result['prepareAdapter'] = json.loads(adapter)
    except Exception as e:
        result['error'] = str(e)[-2500:]
        print(json.dumps({'error': result['error']}))
    finally:
        if host_helper:
            host_helper.terminate()
            try: host_helper.wait(timeout=5)
            except subprocess.TimeoutExpired: host_helper.kill(); host_helper.wait(timeout=5)
        for kind in ['containers', 'volumes', 'networks']:
            for name in reversed(created[kind]):
                args = {'containers': ['rm', '-f'], 'volumes': ['volume', 'rm'], 'networks': ['network', 'rm']}[kind]
                try: docker(*args, name, label='cleanup '+name)
                except Exception as e: result.setdefault('cleanupErrors', []).append(str(e)[-300:])
        if vm_hidden_created:
            try: run(COLIMA+['rm', '-rf', '/tmp/cq-s5-hidden'], label='cleanup VM synthetic files')
            except Exception as e: result.setdefault('cleanupErrors', []).append(str(e)[-300:])
        result['qualificationPassed'] = bool(result.get('allPassed') and result.get('prepareAdapter', {}).get('aclVerified') and not result.get('error') and not result.get('cleanupErrors'))
        result['elapsedSeconds'] = round(time.monotonic()-begin, 2)
        result['operations'] = timings
        (EVIDENCE/'container-probes.json').write_text(json.dumps(result, indent=2)+'\n')
        print(json.dumps({k: v for k, v in result.items() if k not in ['guest', 'operations']}, indent=2))
    return 0 if result.get('allPassed') and not result.get('error') else 1


if __name__ == '__main__':
    raise SystemExit(main())
