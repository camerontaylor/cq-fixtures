/** Explicit no-model operator entrypoint. prepare | scan | cleanup only. */
import { constants, openSync, fstatSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createG2Fixture, provisionG2Guardian, disposeG2Fixture, evaluateG2 } from './g2-harness.ts';
import type { PrivateG2Fixture, G2NativeResult } from './g2-harness.ts';
function privateJSON(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || s.size > 24 * 1024 * 1024 || (s.mode & 0o077)) throw new Error(); return JSON.parse(readFileSync(fd, 'utf8')); }
  finally { closeSync(fd); }
}
export async function main(args: string[]): Promise<void> {
  if (args[0] === 'prepare' && args.length === 1) {
    const fixture = createG2Fixture();
    try { await provisionG2Guardian(fixture); }
    catch { await disposeG2Fixture(fixture); throw new Error('G2 fixture preparation failed'); }
    console.log(JSON.stringify({ fixture: fixture.privateRoot + '/fixture.json', prompt: fixture.privateRoot + '/prompt.txt', modelCalls: 0, status: 'private-fixture-only' }));
  } else if (args[0] === 'scan' && args.length === 4) {
    const fixture = privateJSON(args[1]) as PrivateG2Fixture;
    const raw = privateJSON(args[2]);
    const result = { ...raw, rawOutputs: raw.rawOutputs.map((b: string) => Buffer.from(b, 'base64')), traces: raw.traces.map((t: { output: string }) => ({ ...t, output: Buffer.from(t.output, 'base64') })) } as G2NativeResult;
    // Offline scanner cannot authenticate actual native/ledger provenance by JSON alone.
    result.provenance = 'synthetic';
    writeFileSync(args[3], JSON.stringify(evaluateG2(fixture, result), null, 2), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ reportWritten: true, actualRouteQualification: false, modelCalls: 0 }));
  } else if (args[0] === 'cleanup' && args.length === 2) {
    await disposeG2Fixture(privateJSON(args[1]) as PrivateG2Fixture); console.log(JSON.stringify({ cleanupComplete: true, modelCalls: 0 }));
  } else throw new Error('only prepare, scan PRIVATE_FIXTURE PRIVATE_RESULT NEW_REPORT, cleanup PRIVATE_FIXTURE allowed');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(process.argv.slice(2)); }
  catch { console.error('bounded G2 operation unavailable; no private contents disclosed'); process.exitCode = 1; }
}
