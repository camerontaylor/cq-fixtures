import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync, mkdtempSync, rmSync, chmodSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DockerControl } from './docker-control.ts';
import { snapshotTask, validateTaskEntries, materializeTask, taskIdentity } from './task-tree.ts';
import type { TaskTree } from './task-tree.ts';

export interface TaskStageReceipt {
  daemonId: string; utilityImage: string; taskVolume: string; contextVolume: string;
  baselineCommit: string; taskIdentity: string; task: TaskTree; context: TaskTree; receiptHash: string;
}
function volumeScript(): string {
  const local = new URL('./volume-io.mjs', import.meta.url);
  const source = new URL('../../runner/boundary/volume-io.mjs', import.meta.url);
  return readFileSync(fileURLToPath(existsSync(local) ? local : source), 'utf8');
}
const HASH = /^[a-f0-9]{64}$/;
const IMAGE = /^(?:[a-z0-9./_-]+@)?sha256:[a-f0-9]{64}$/;
function receiptHash(receipt: Omit<TaskStageReceipt, 'receiptHash'>): string {
  return createHash('sha256').update(JSON.stringify({ daemonId: receipt.daemonId, utilityImage: receipt.utilityImage,
    taskVolume: receipt.taskVolume, contextVolume: receipt.contextVolume, baselineCommit: receipt.baselineCommit,
    taskIdentity: receipt.taskIdentity, taskInventory: receipt.task.inventoryHash, contextInventory: receipt.context.inventoryHash })).digest('hex');
}
export function validateStageReceipt(receipt: TaskStageReceipt): void {
  if (!IMAGE.test(receipt.utilityImage) || !/^cq-s5-task-[a-f0-9]{16}$/.test(receipt.taskVolume) ||
      !/^cq-s5-context-[a-f0-9]{16}$/.test(receipt.contextVolume) || !HASH.test(receipt.receiptHash) ||
      validateTaskEntries(receipt.task.entries).inventoryHash !== receipt.task.inventoryHash ||
      validateTaskEntries(receipt.context.entries, false, false).inventoryHash !== receipt.context.inventoryHash ||
      taskIdentity(receipt.task, receipt.baselineCommit) !== receipt.taskIdentity || receiptHash(receipt) !== receipt.receiptHash) throw new Error('private staging content inventory invalid');
}

/** Git runs only on a validated fresh private tree, with normalized local config.
 * No candidate config, hooks, replace objects or alternates can select host paths.
 */
export function verifyGitBaseline(tree: TaskTree, baselineCommit: string): { head: string; baselinePresent: true } {
  validateTaskEntries(tree.entries); if (!/^[a-f0-9]{40}$/.test(baselineCommit)) throw new Error('exact Git baseline required');
  const directory = mkdtempSync(join(tmpdir(), 'cq-s5-git-audit-')); chmodSync(directory, 0o700);
  try {
    materializeTask(tree, directory);
    const options = { cwd: directory, env: { PATH: '/usr/bin:/bin', HOME: directory, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' }, timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8' as const };
    const git = (args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], options).trim();
    git(['cat-file', '-e', baselineCommit + '^{commit}']); git(['fsck', '--full', '--no-reflogs', '--no-progress']);
    const head = git(['rev-parse', '--verify', 'HEAD']);
    if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('candidate HEAD invalid');
    git(['merge-base', '--is-ancestor', baselineCommit, head]);
    return { head, baselinePresent: true };
  } finally {
    const writable = (path: string) => { if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name)); } };
    writable(directory); rmSync(directory, { recursive: true, force: true });
  }
}

async function volumeEntries(control: DockerControl, receipt: TaskStageReceipt, volume: string): Promise<TaskTree> {
  const script = volumeScript();
  const output = await control.utility([ '--rm', '--pull=never', '--network', 'none', '--user', '1000:1000', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '32', '--memory', '768m', '--cpus', '1',
    '--mount', `type=volume,source=${volume},target=/task,readonly,volume-nocopy`, '--entrypoint', '/usr/local/bin/node',
    receipt.utilityImage, '-e', script, 'read'], undefined, 100 * 1024 * 1024);
  return validateTaskEntries(JSON.parse(output), false, volume === receipt.taskVolume);
}

export async function verifyStageVolumes(control: DockerControl, receipt: TaskStageReceipt): Promise<void> {
  validateStageReceipt(receipt);
  if (await control.run(['info', '--format', '{{.ID}}']) !== receipt.daemonId) throw new Error('staging daemon changed');
  for (const [volume, kind, expected] of [[receipt.taskVolume, 'task', receipt.task], [receipt.contextVolume, 'context', receipt.context]] as const) {
    const metadata = JSON.parse(await control.run(['volume', 'inspect', volume]))[0];
    if (metadata.Driver !== 'local' || Object.keys(metadata.Options ?? {}).length ||
        metadata.Labels?.['cq.boundary.staging'] !== receipt.receiptHash || metadata.Labels?.['cq.boundary.kind'] !== kind) throw new Error('private volume ownership mismatch');
    if ((await control.run(['ps', '-aq', '--filter', `volume=${volume}`])).trim()) throw new Error('staged volume is already attached');
    if ((await volumeEntries(control, receipt, volume)).inventoryHash !== expected.inventoryHash) throw new Error('live volume content differs from private inventory');
  }
}

export async function stageTaskClone(request: { taskRoot: string; contextRoot: string; baselineCommit: string; utilityImage: string }): Promise<TaskStageReceipt> {
  if (!IMAGE.test(request.utilityImage)) throw new Error('content-pinned utility image required');
  const task = snapshotTask(request.taskRoot, true); const context = snapshotTask(request.contextRoot, false, false);
  const baseline = verifyGitBaseline(task, request.baselineCommit);
  if (baseline.head !== request.baselineCommit) throw new Error('source clone HEAD differs from intended baseline');
  const control = new DockerControl(); const created: string[] = [];
  const token = randomBytes(8).toString('hex');
  const initial = { daemonId: await control.run(['info', '--format', '{{.ID}}']).catch((error) => { control.close(); throw error; }), utilityImage: request.utilityImage,
    taskVolume: 'cq-s5-task-' + token, contextVolume: 'cq-s5-context-' + token, baselineCommit: request.baselineCommit,
    taskIdentity: taskIdentity(task, request.baselineCommit), task, context };
  const receipt: TaskStageReceipt = { ...initial, receiptHash: receiptHash(initial) };
  try {
    for (const [volume, kind, tree] of [[receipt.taskVolume, 'task', task], [receipt.contextVolume, 'context', context]] as const) {
      if ((await control.run(['volume', 'ls', '-q'])).split('\n').includes(volume)) throw new Error('volume name already exists');
      await control.run(['volume', 'create', '--label', `cq.boundary.staging=${receipt.receiptHash}`, '--label', `cq.boundary.kind=${kind}`, volume]); created.push(volume);
      const script = volumeScript();
      // Trusted stager has only CHOWN; it is never a worker and gets no network/auth.
      await control.utility([ '--rm', '-i', '--pull=never', '--network', 'none', '--user', '0:0', '--read-only', '--cap-drop', 'ALL',
        '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges', '--pids-limit', '32', '--memory', '768m', '--cpus', '1',
        '--mount', `type=volume,source=${volume},target=/task,volume-nocopy`, '--entrypoint', '/usr/local/bin/node',
        receipt.utilityImage, '-e', script, 'write'], JSON.stringify(tree.entries));
    }
    await verifyStageVolumes(control, receipt); return receipt;
  } catch (e) { for (const volume of created.reverse()) await control.run(['volume', 'rm', volume]); throw e; }
  finally { control.close(); }
}

/** Caller has already torn down the worker. Confirm no container still attaches
 * task, then read only that immutable volume, validate links and baseline, export.
 */
export async function exportStoppedTask(control: DockerControl, receipt: TaskStageReceipt, destination: string): Promise<{ inventoryHash: string; head: string }> {
  validateStageReceipt(receipt);
  if (await control.run(['info', '--format', '{{.ID}}']) !== receipt.daemonId) throw new Error('export daemon changed');
  if ((await control.run(['ps', '-aq', '--filter', `volume=${receipt.taskVolume}`])).trim()) throw new Error('task volume still attached; teardown must precede export');
  const metadata = JSON.parse(await control.run(['volume', 'inspect', receipt.taskVolume]))[0];
  if (metadata.Driver !== 'local' || Object.keys(metadata.Options ?? {}).length || metadata.Labels?.['cq.boundary.staging'] !== receipt.receiptHash || metadata.Labels?.['cq.boundary.kind'] !== 'task') throw new Error('export volume ownership changed');
  const tree = await volumeEntries(control, receipt, receipt.taskVolume);
  const baseline = verifyGitBaseline(tree, receipt.baselineCommit);
  materializeTask(tree, destination);
  return { inventoryHash: tree.inventoryHash, head: baseline.head };
}
