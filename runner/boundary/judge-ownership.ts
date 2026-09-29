/** Private parent preregistration for protected oracle resources. No caller-selected namespaces. */
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, realpathSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { validateTaskEntries, type TaskTree } from './task-tree.ts';
import { DockerControl } from './docker-control.ts';
import { FINAL_NATIVE_IMAGE } from './codex-final-profile.ts';

const DAEMON = 'e15e4bd0-8a2f-4f5b-b335-2bd18da11100';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const parentHandles = new WeakSet<JudgeNamespaceHandle>();
const digest = (value: string) => /^[a-f0-9]{64}$/.test(value);
export interface JudgeAttemptIdentity { assignmentId: string; stageId: string; attemptId: string; }
export interface JudgeNamespaceSlot { index: number; inventoryHash: string; volume: string; writer: string; candidate: string; }
export interface JudgeNamespacePlan {
  schemaVersion: 1; identity: JudgeAttemptIdentity; candidateSha256: string; oraclePin: string;
  namespace: string; daemonId: string; image: string; slots: JudgeNamespaceSlot[];
}
export interface JudgeNamespaceHandle { planPath: string; planSha256: string; plan: JudgeNamespacePlan; }
export interface JudgeNamespaceCleanupProof {
  identity: JudgeAttemptIdentity; planSha256: string; daemonVerified: boolean; ownershipVerified: boolean;
  containersAbsent: boolean; processTree: 'stopped-and-reaped' | 'unproven';
  volumeDisposition: 'quarantined' | 'absent' | 'unproven'; resourceIds: string[]; cleanup: 'complete' | 'failed';
  /** Retained volume bytes are not attested by a label or by namespace teardown. */
  inventoryContentVerified: false;
}
export interface JudgeOwnershipControl { run(args: string[], input?: string, maxBytes?: number, timeoutMs?: number): Promise<string>; close(): void; }
function privatePath(path: string, directory: boolean): void {
  if (!isAbsolute(path) || realpathSync(path) !== path) throw new Error('canonical private judge path required');
  for (let current = path;; current = dirname(current)) {
    const st = lstatSync(current);
    if (st.isSymbolicLink() || (current === path && st.uid !== process.getuid?.())) throw new Error('judge path ownership changed');
    if (current === path && ((st.mode & 0o077) || (directory ? !st.isDirectory() : !st.isFile()))) throw new Error('private judge path required');
    if (dirname(current) === current) break;
  }
}
function validatePlan(plan: JudgeNamespacePlan): void {
  if (plan.schemaVersion !== 1 || plan.daemonId !== DAEMON || plan.image !== FINAL_NATIVE_IMAGE ||
      !/^[a-f0-9]{24}$/.test(plan.namespace) || !digest(plan.candidateSha256) || !digest(plan.oraclePin) ||
      !plan.identity || Object.values(plan.identity).length !== 3 || Object.values(plan.identity).some(v => typeof v !== 'string' || !v || v.length > 180) ||
      !Array.isArray(plan.slots) || !plan.slots.length || plan.slots.length > 8) throw new Error('frozen judge plan invalid');
  plan.slots.forEach((slot, index) => {
    const prefix = `cq-s5-judge-${plan.namespace}-${index}`;
    if (slot.index !== index || !digest(slot.inventoryHash) || slot.volume !== prefix + '-task' || slot.writer !== prefix + '-writer' || slot.candidate !== prefix + '-candidate') throw new Error('frozen judge slot invalid');
  });
}
export function stableJudgeCandidateInventory(module: string, bytes: Uint8Array): TaskTree {
  if (!/^[A-Za-z0-9_.\/-]+\.(?:js|mjs|cjs|ts)$/.test(module) || module.startsWith('/') || module.split('/').some(p => !p || p === '.' || p === '..' || p === '.git')) throw new Error('plain relative candidate module required');
  const parts = module.split('/'), entries: TaskTree['entries'] = [];
  for (let i = 1; i < parts.length; i++) entries.push({ path: parts.slice(0,i).join('/'), kind: 'directory', mode: 0o755 });
  entries.push({ path: module, kind: 'file', mode: 0o644, data: Buffer.from(bytes).toString('base64') });
  return validateTaskEntries(entries, false, false);
}

export function createJudgeNamespacePlan(input: { privateParentRoot: string; identity: JudgeAttemptIdentity; candidateSha256: string; oraclePin: string; inventoryHashes: readonly string[] }): JudgeNamespaceHandle {
  privatePath(input.privateParentRoot, true);
  const namespace = randomBytes(12).toString('hex');
  const plan: JudgeNamespacePlan = { schemaVersion: 1, identity: { ...input.identity }, candidateSha256: input.candidateSha256, oraclePin: input.oraclePin, namespace, daemonId: DAEMON, image: FINAL_NATIVE_IMAGE,
    slots: input.inventoryHashes.map((inventoryHash, index) => ({ index, inventoryHash, volume: `cq-s5-judge-${namespace}-${index}-task`, writer: `cq-s5-judge-${namespace}-${index}-writer`, candidate: `cq-s5-judge-${namespace}-${index}-candidate` })) };
  validatePlan(plan);
  const root = join(input.privateParentRoot, 'judge-namespace-' + namespace); mkdirSync(root, { mode: 0o700 });
  const planPath = join(root, 'plan.json'), bytes = JSON.stringify(plan);
  writeFileSync(planPath, bytes, { mode: 0o600, flag: 'wx' });
  plan.slots.forEach(Object.freeze); Object.freeze(plan.slots); Object.freeze(plan.identity); Object.freeze(plan);
  const handle = Object.freeze({ planPath, planSha256: sha(bytes), plan }); parentHandles.add(handle); return handle;
}
function readPlan(path: string): JudgeNamespaceHandle {
  privatePath(dirname(path), true); privatePath(path, false); const bytes = readFileSync(path, 'utf8'); const plan = JSON.parse(bytes) as JudgeNamespacePlan; validatePlan(plan);
  return { planPath: path, planSha256: sha(bytes), plan };
}
export function judgeSlotLabels(handle: JudgeNamespaceHandle, slot: JudgeNamespaceSlot): Record<string, string> {
  return { 'cq.boundary.judge.plan': handle.planSha256, 'cq.boundary.judge.slot': String(slot.index), 'cq.boundary.judge.inventory': slot.inventoryHash };
}
export function claimJudgeNamespaceSlot(planPath: string, inventoryHash: string): { handle: JudgeNamespaceHandle; slot: JudgeNamespaceSlot; labels: Record<string, string> } {
  const handle = readPlan(planPath);
  for (const slot of handle.plan.slots.filter(s => s.inventoryHash === inventoryHash)) {
    try { writeFileSync(join(dirname(planPath), `claim-${slot.index}.json`), JSON.stringify({ planSha256: handle.planSha256, inventoryHash }), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
    return { handle, slot, labels: judgeSlotLabels(handle, slot) };
  }
  throw new Error('no preregistered judge inventory slot available');
}
/** Parent must stop/reap the trusted host process before cleanup, preventing late creates. */
export async function cleanupJudgeNamespace(handle: JudgeNamespaceHandle, input: { hostProcessStopped: boolean; deadlineEpochMs: number }, suppliedControl?: JudgeOwnershipControl): Promise<JudgeNamespaceCleanupProof> {
  const proof: JudgeNamespaceCleanupProof = { identity: { ...handle.plan.identity }, planSha256: handle.planSha256, daemonVerified: false, ownershipVerified: false, containersAbsent: false, processTree: 'unproven', volumeDisposition: 'unproven', resourceIds: [], cleanup: 'failed', inventoryContentVerified: false };
  if (!parentHandles.has(handle) || !input.hostProcessStopped || !Number.isFinite(input.deadlineEpochMs) || input.deadlineEpochMs <= Date.now() || input.deadlineEpochMs > Date.now() + 30000) return proof;
  let control: JudgeOwnershipControl | undefined;
  try {
    const actual = readPlan(handle.planPath);
    if (actual.planSha256 !== handle.planSha256 || JSON.stringify(actual.plan) !== JSON.stringify(handle.plan)) throw new Error('judge plan changed');
    control = suppliedControl ?? new DockerControl();
    const run = (args: string[]) => { const remaining = Math.floor(input.deadlineEpochMs - Date.now()); if (remaining <= 0) throw new Error('judge cleanup deadline'); return control!.run(args, undefined, 256 * 1024, remaining); };
    if (await run(['info','--format','{{.ID}}']) !== handle.plan.daemonId) throw new Error('judge daemon changed'); proof.daemonVerified = true;
    const owned: string[] = [], volumes: string[] = [];
    for (const slot of handle.plan.slots) {
      const labels = judgeSlotLabels(handle, slot);
      for (const name of [slot.writer, slot.candidate]) {
        const ids = await run(['ps','-aq','--no-trunc','--filter',`name=^/${name}$`]);
        if (!ids) continue;
        if (!/^[a-f0-9]{64}$/.test(ids)) throw new Error('ambiguous judge resource');
        const items = JSON.parse(await run(['inspect',ids])); if (!Array.isArray(items) || items.length !== 1) throw new Error('judge inspect unavailable'); const obj = items[0];
        if (obj.Id !== ids || obj.Name !== '/' + name || obj.Image !== handle.plan.image || obj.Config?.Image !== handle.plan.image ||
            Object.entries(labels).some(([k,v]) => obj.Config?.Labels?.[k] !== v) || obj.HostConfig?.NetworkMode !== 'none' || obj.HostConfig?.Privileged !== false || obj.HostConfig?.PidMode ||
            obj.Config?.User !== (name === slot.writer ? '0:0' : '1000:1000') || obj.HostConfig?.ReadonlyRootfs !== true ||
            !Array.isArray(obj.Mounts) || obj.Mounts.length !== 1 || obj.Mounts[0].Type !== 'volume' || obj.Mounts[0].Name !== slot.volume || obj.Mounts[0].Destination !== '/task' || obj.Mounts[0].RW !== (name === slot.writer)) throw new Error('judge resource ownership/config changed');
        owned.push(ids);
      }
      const names = await run(['volume','ls','-q','--filter','name=^' + slot.volume + '$']);
      if (names && names !== slot.volume) throw new Error('ambiguous judge volume');
      if (names) {
        const items = JSON.parse(await run(['volume','inspect',slot.volume])); const v = items[0];
        if (items.length !== 1 || v.Name !== slot.volume || v.Driver !== 'local' || Object.keys(v.Options ?? {}).length || Object.entries(labels).some(([k,val]) => v.Labels?.[k] !== val)) throw new Error('judge volume ownership changed');
        const attached = (await run(['ps','-aq','--no-trunc','--filter','volume=' + slot.volume])).split('\n').filter(Boolean);
        if (attached.some(id => !owned.includes(id))) throw new Error('foreign judge volume attachment');
        volumes.push(slot.volume);
      }
    }
    const scoped = (await run(['ps','-aq','--no-trunc','--filter','label=cq.boundary.judge.plan=' + handle.planSha256])).split('\n').filter(Boolean);
    if (scoped.length !== owned.length || scoped.some(id => !owned.includes(id))) throw new Error('undeclared judge plan container');
    const scopedVolumes = (await run(['volume','ls','-q','--filter','label=cq.boundary.judge.plan=' + handle.planSha256])).split('\n').filter(Boolean);
    if (scopedVolumes.length !== volumes.length || scopedVolumes.some(name => !volumes.includes(name))) throw new Error('undeclared judge plan volume');
    proof.ownershipVerified = true; proof.resourceIds = [...owned, ...volumes];
    for (const id of owned) await run(['rm','-f',id]);
    for (const slot of handle.plan.slots) {
      for (const name of [slot.writer,slot.candidate]) if (await run(['ps','-aq','--no-trunc','--filter',`name=^/${name}$`])) throw new Error('judge namespace remains');
      if (await run(['ps','-aq','--no-trunc','--filter','volume=' + slot.volume])) throw new Error('judge volume remains attached');
    }
    if (await run(['ps','-aq','--no-trunc','--filter','label=cq.boundary.judge.plan=' + handle.planSha256])) throw new Error('judge plan namespace remains');
    if (Date.now() >= input.deadlineEpochMs) throw new Error('judge cleanup deadline');
    proof.containersAbsent = true; proof.processTree = 'stopped-and-reaped'; proof.volumeDisposition = volumes.length ? 'quarantined' : 'absent'; proof.cleanup = 'complete';
  } catch { /* Fixed typed failure only; private plan and all recovery stay intact. */ }
  finally { control?.close(); }
  return proof;
}
