/** No-model qualification. Creates only private labeled volumes on fixed daemon. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { stageTaskClone, verifyStageVolumes } from './task-staging.ts';
import { DockerControl } from './docker-control.ts';
import { containerTaskSession } from './task-session.ts';

const image = process.argv[2];
const root = mkdtempSync(join(tmpdir(), 'cq-s5-lifecycle-')); const task = join(root, 'task'); const context = join(root, 'context');
mkdirSync(task); mkdirSync(context); writeFileSync(join(context, 'visible.txt'), 'synthetic-context');
const git = (args: string[]) => execFileSync('/usr/bin/git', args, { cwd: task, encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
git(['init', '-q']); writeFileSync(join(task, 'delete.txt'), 'delete'); writeFileSync(join(task, 'edit.txt'), 'baseline');
git(['add', '.']); git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@invalid', 'commit', '-qm', 'baseline']);
const baseline = git(['rev-parse', 'HEAD']); const started = Date.now(); const control = new DockerControl();
let session: ReturnType<typeof containerTaskSession> | undefined;
try {
  const receipt = await stageTaskClone({ taskRoot: task, contextRoot: context, baselineCommit: baseline, utilityImage: image });
  // Same private labels, different actual content must fail.
  await control.utility(['--rm', '--pull=never', '--network', 'none', '--user', '1000:1000', '--mount', `type=volume,source=${receipt.taskVolume},target=/task`, '--entrypoint', '/bin/sh', image, '-c', 'printf tamper > /task/edit.txt']);
  let tamperDenied = false; try { await verifyStageVolumes(control, receipt); } catch { tamperDenied = true; }
  if (!tamperDenied) throw new Error('label-only tamper was accepted');
  const id = await control.run(['create', '--pull=never', '--network', 'none', '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '768m', '--cpus', '1', '--pids-limit', '32', '--workdir', '/task', '--mount', `type=volume,source=${receipt.taskVolume},target=/task`, '--entrypoint', '/usr/local/bin/node', image, '-e', 'setInterval(()=>{},10000)']);
  session = containerTaskSession(receipt, id); await control.run(['start', id]);
  await control.run(['exec', id, '/bin/sh', '-c', "printf candidate > edit.txt; rm delete.txt; printf '#!/bin/sh\nexit 0\n' > executable; chmod 755 executable; ln -s edit.txt safe-link; git -c safe.directory=/task add -A; git -c safe.directory=/task -c user.name=Synthetic -c user.email=synthetic@invalid commit -qm candidate; printf partial > .untracked"]);
  const child = spawn('/usr/local/bin/docker', [...control.prefix, 'exec', id, '/usr/local/bin/node', '-e', "require('fs').writeFileSync('/task/ready','ready');setInterval(()=>require('fs').appendFileSync('/task/.partial','x'),50)"], { env: control.environment, stdio: 'pipe' });
  await once(child, 'spawn');
  // Bounded readiness check in a single foreground exec, no polling loop.
  await control.run(['exec', id, '/usr/local/bin/node', '-e', "setTimeout(()=>{if(!require('fs').existsSync('/task/ready'))process.exit(2)},500)"]);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 250);
  await once(child, 'close'); clearTimeout(timeout);
  const destination = join(root, 'export'); mkdirSync(destination);
  const result = await session.finalize(destination); await session.terminate();
  if (result.head === baseline || existsSync(join(destination, 'delete.txt')) || readFileSync(join(destination, 'edit.txt'), 'utf8') !== 'candidate' || readFileSync(join(destination, '.untracked'), 'utf8') !== 'partial' || !existsSync(join(destination, '.partial')) || (lstatSync(join(destination, 'executable')).mode & 0o777) !== 0o755 || !lstatSync(join(destination, 'safe-link')).isSymbolicLink()) throw new Error('candidate export lost state');
  await session.cleanup();
  // Host snapshot rejects hidden path links without traversing them.
  symlinkSync('/hidden/judge', join(task, 'escape'));
  let escapeDenied = false; try { await stageTaskClone({ taskRoot: task, contextRoot: context, baselineCommit: baseline, utilityImage: image }); } catch { escapeDenied = true; }
  if (!escapeDenied) throw new Error('hidden path symlink accepted');
  console.log(JSON.stringify({ kind: 'synthetic-no-model-task-lifecycle', passed: true, tamperedLabelDenied: true, timeoutClientKillThenContainerTeardown: true, baselineIntegrity: true, commitsModesDeletionsUntrackedPreserved: true, hiddenSymlinkDenied: true, seconds: (Date.now() - started) / 1000, utilityImage: image, g2: 'blocked' }));
} finally { session?.closeControl(); control.close(); rmSync(root, { recursive: true, force: true }); }
