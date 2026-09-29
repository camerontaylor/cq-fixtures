/** Exact public broker code/config inventory; no auth or host mounts. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateTaskEntries } from './task-tree.ts';
import type { TaskTree } from './task-tree.ts';
import type { DockerControl } from './docker-control.ts';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const BROKER_ASSET_SHA256 = {
  'broker.mjs': 'f20f5e3e74b8a3c545f417a03f12b144254bf1f27b57293e5419164d80c2fc6d',
  'config.json': 'c6d8d0b3dba5ac98779663e4cc75b92107fddb14430fc42180f4ec675c0f99b0',
};
export function validateBrokerAssets(tree: TaskTree): void {
  const valid = validateTaskEntries(tree.entries, false, false);
  if (valid.inventoryHash !== tree.inventoryHash || tree.entries.length !== 2 || tree.entries.some(e => e.kind !== 'file' || e.mode !== 0o600 || !Object.hasOwn(BROKER_ASSET_SHA256, e.path) || hash(Buffer.from(e.data!, 'base64')) !== BROKER_ASSET_SHA256[e.path as keyof typeof BROKER_ASSET_SHA256])) throw new Error('exact two public broker assets required');
}
export function brokerAssetTree(): TaskTree {
  const entries = Object.keys(BROKER_ASSET_SHA256).map(path => ({ path, kind: 'file' as const, mode: 0o600, data: readFileSync(new URL('./broker-public-assets/' + path, import.meta.url)).toString('base64') }));
  const tree = validateTaskEntries(entries, false, false); validateBrokerAssets(tree); return tree;
}
export function brokerRuntimeIdentity(inventoryHash: string): string {
  return hash(JSON.stringify({ strategy: 'nonroot-public-toolchain-v2', routeIdentity: BROKER_ASSET_SHA256['config.json'], image: 'sha256:a0af04214c67a25e4c5ab01b20f6e6deea98fc664b65ae5532576949234adfe3', user: '1000:1000', entrypoint: ['/usr/local/bin/node'], args: ['/opt/broker.mjs', '/opt/config.json'], assetInventoryHash: inventoryHash, mount: { destination: '/opt', readonly: true, type: 'exclusive-public-toolchain-volume' }, capabilities: 'ALL-dropped', readonlyRootfs: true }));
}
export const FINAL_BROKER_ASSET_INVENTORY = brokerAssetTree().inventoryHash;
export const FINAL_BROKER_RUNTIME_IDENTITY = brokerRuntimeIdentity(FINAL_BROKER_ASSET_INVENTORY);
export function validateLiveBrokerToolchain(input: {
  broker: { Image: string; Config: { User: string; Entrypoint: string[]; Cmd: string[]; Labels: Record<string, string> }; HostConfig: { ReadonlyRootfs: boolean; Privileged: boolean; PidMode: string; CapDrop: string[]; CapAdd: string[] | null; Binds: string[] | null; PortBindings: Record<string, unknown> | null }; Mounts: Array<{ Type: string; Name: string; Destination: string; RW: boolean }> };
  volume: { Driver: string; Options: Record<string, unknown> | null; Labels: Record<string, string> };
  runId: string; volumeName: string; liveInventory: TaskTree;
}): void {
  const { broker: c, volume: v } = input;
  validateBrokerAssets(input.liveInventory);
  if (!/^cq-s5-broker-assets-[a-f0-9]{16}$/.test(input.volumeName) || c.Image !== 'sha256:a0af04214c67a25e4c5ab01b20f6e6deea98fc664b65ae5532576949234adfe3' || c.Config.User !== '1000:1000' || JSON.stringify(c.Config.Entrypoint) !== '["/usr/local/bin/node"]' || JSON.stringify(c.Config.Cmd) !== '["/opt/broker.mjs","/opt/config.json"]' || c.Config.Labels?.['cq.boundary.runtime'] !== input.runId || c.Config.Labels?.['cq.boundary.broker-runtime'] !== FINAL_BROKER_RUNTIME_IDENTITY || !c.HostConfig.ReadonlyRootfs || c.HostConfig.Privileged || c.HostConfig.PidMode || !c.HostConfig.CapDrop?.includes('ALL') || c.HostConfig.CapAdd?.length || c.HostConfig.Binds?.length || Object.keys(c.HostConfig.PortBindings ?? {}).length || c.Mounts.length !== 1 || c.Mounts[0].Type !== 'volume' || c.Mounts[0].Name !== input.volumeName || c.Mounts[0].Destination !== '/opt' || c.Mounts[0].RW || v.Driver !== 'local' || Object.keys(v.Options ?? {}).length || v.Labels?.['cq.boundary.runtime'] !== input.runId || v.Labels?.['cq.boundary.public-assets'] !== FINAL_BROKER_ASSET_INVENTORY) throw new Error('live exclusive read-only public broker toolchain mismatch');
}
export async function verifyLiveBrokerToolchain(control: DockerControl, containerId: string, volumeName: string, runId: string): Promise<void> {
  const broker = JSON.parse(await control.run(['inspect', containerId]))[0];
  const volume = JSON.parse(await control.run(['volume', 'inspect', volumeName]))[0];
  const output = await control.run(['exec', containerId, '/usr/local/bin/node', '-e', "const fs=require('fs');const names=fs.readdirSync('/opt').sort();console.log(JSON.stringify(names.map(path=>{const s=fs.lstatSync('/opt/'+path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>65536||s.uid!==1000)throw Error('public asset inventory');return {path,kind:'file',mode:s.mode&511,data:fs.readFileSync('/opt/'+path).toString('base64')}})))"], undefined, 128 * 1024);
  validateLiveBrokerToolchain({ broker, volume, runId, volumeName, liveInventory: validateTaskEntries(JSON.parse(output), false, false) });
  if (await control.run(['ps','-aq','--no-trunc','--filter','volume=' + volumeName]) !== containerId) throw new Error('broker public volume not exclusive');
}
