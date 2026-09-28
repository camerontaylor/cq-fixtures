#!/usr/bin/env python3
"""Build declared Linux runtimes, then offline startup only; no auth/model routes."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
BASE = 'node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6'
DOCKER = ['docker', '--context', 'colima-cq-boundary-s5']
PI = Path('/Users/ctaylor/.local/share/mise/installs/node/24/lib/node_modules/@earendil-works/pi-coding-agent')


def main():
    begin = time.monotonic()
    result = {'g2': 'not-established', 'modelCalls': 0, 'authenticationStaged': False, 'routesTested': False}
    with tempfile.TemporaryDirectory(prefix='cq-s5-runtime-image-') as root:
        root = Path(root)
        inventory = []
        # Explicit distribution subset only. Reject symlinks, never copy homes/config/auth.
        for source, target in [(PI/'package.json', root/'pi/package.json'), (PI/'dist/bundle', root/'pi/dist/bundle'),
                               (PI/'node_modules/@earendil-works/chord/package.json', root/'pi/node_modules/@earendil-works/chord/package.json'),
                               (PI/'node_modules/@earendil-works/chord/dist', root/'pi/node_modules/@earendil-works/chord/dist')]:
            sources = sorted(source.rglob('*')) if source.is_dir() else [source]
            for file in sources:
                if file.is_symlink():
                    raise RuntimeError('toolchain symlink refused')
                if not file.is_file():
                    continue
                dest = target/file.relative_to(source) if source.is_dir() else target
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(file, dest)
                inventory.append({'path': str(dest.relative_to(root)), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()})
        result['piDistributionHash'] = hashlib.sha256(json.dumps(inventory, sort_keys=True).encode()).hexdigest()
        result['piDistributionFiles'] = len(inventory)
        (root/'Dockerfile').write_text(f'''FROM {BASE}
RUN npm install --global --ignore-scripts @openai/codex@0.155.1 zcode-acp-server@0.37.3 --fetch-retries=0 --fetch-timeout=15000 && rm -rf /root/.npm
COPY pi /opt/pi
RUN mkdir -p /task /home/worker && chown 1000:1000 /task /home/worker
USER 1000:1000
''')
        try:
            build = subprocess.run(DOCKER+['build', '-t', 'cq-s5-native-runtime:local', str(root)], capture_output=True, text=True, timeout=180)
            result['buildExitCode'] = build.returncode
            if build.returncode:
                # Retain exact installation error, no credentials are present in this build.
                result['buildError'] = (build.stdout+build.stderr)[-4500:]
            else:
                result['imageId'] = subprocess.check_output(DOCKER+['image', 'inspect', 'cq-s5-native-runtime:local', '--format', '{{.Id}}'], text=True, timeout=15).strip()
                common = DOCKER+['run', '--rm', '--network', 'none', '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL',
                                 '--security-opt', 'no-new-privileges', '--memory', '384m', '--memory-swap', '384m', '--cpus', '0.5',
                                 '--pids-limit', '64', '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m,uid=1000,gid=1000',
                                 '--tmpfs', '/home/worker:rw,nosuid,nodev,noexec,size=32m,uid=1000,gid=1000',
                                 '--env', 'HOME=/home/worker', '--env', 'XDG_CONFIG_HOME=/home/worker/.config',
                                 '--workdir', '/task', 'cq-s5-native-runtime:local']
                probes = {}
                for name, args in [('codex', ['codex', '--version']), ('pi', ['node', '/opt/pi/dist/bundle/cli.js', '--version']),
                                   ('zcode', ['zcode-acp', '--help'])]:
                    t = time.monotonic()
                    try:
                        p = subprocess.run(common+args, capture_output=True, text=True, timeout=15)
                        version = re.search(r'\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\b', p.stdout)
                        codes = re.findall(r'\b(?:ERR_[A-Z_]+|E[A-Z0-9]{3,})\b', p.stderr)
                        probes[name] = {'exitCode': p.returncode, 'elapsedSeconds': round(time.monotonic()-t, 2),
                                        'version': version.group(0) if name != 'zcode' and version else None,
                                        'helpUsageObserved': name == 'zcode' and 'Usage: zcode-acp' in p.stdout,
                                        'errorCodes': sorted(set(codes)), 'network': 'none', 'auth': 'absent'}
                    except subprocess.TimeoutExpired:
                        probes[name] = {'timedOut': True, 'elapsedSeconds': round(time.monotonic()-t, 2)}
                result['probes'] = probes
        except subprocess.TimeoutExpired:
            result['buildTimedOut'] = True
    result['elapsedSeconds'] = round(time.monotonic()-begin, 2)
    (HERE/'evidence/fallback/linux-runtime-startup.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
