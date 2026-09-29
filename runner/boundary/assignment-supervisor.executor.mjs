/** Private operation executor. No provider payload or auth is sent over IPC. */
import { readFileSync, lstatSync, realpathSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const hash = b => createHash('sha256').update(b).digest('hex');
const bytes = readFileSync(process.argv[2]);
if (hash(bytes) !== process.argv[3]) throw Error('executor descriptor changed');
const job = JSON.parse(bytes);
const send = m => process.send?.({ ...m, identity: job.identity });
let sequence = 0;
async function preregister(resource) {
  const id = ++sequence;
  await new Promise((resolve, reject) => {
    const listen = m => { if (m.type === 'registered' && m.sequence === id) { process.off('message', listen); resolve(); } };
    process.on('message', listen);
    process.once('disconnect', () => reject(Error('parent ownership lost')));
    send({ type: 'register', resource, sequence: id });
  });
}
process.on('disconnect', () => process.exit(125));
try {
  for (const [index, op] of job.operations.entries()) {
    if (realpathSync(op.modulePath) !== op.modulePath || hash(readFileSync(op.modulePath)) !== op.moduleSha256 || Date.now() >= op.deadlineEpochMs) throw Error('operation pin/deadline changed');
    const stat = lstatSync(op.privateInputPath);
    if (hash(readFileSync(op.privateInputPath)) !== op.privateInputSha256 || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.uid !== process.getuid?.() || realpathSync(op.privateInputPath) !== op.privateInputPath) throw Error('private input changed');
    const module = await import(pathToFileURL(op.modulePath).href);
    if (typeof module[op.exportName] !== 'function') throw Error('allowed export unavailable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, op.deadlineEpochMs - Date.now()));
    let result;
    try { result = await module[op.exportName]({ privateInputPath: op.privateInputPath, identity: job.identity, deadlineEpochMs: op.deadlineEpochMs, signal: controller.signal, preregister }); }
    finally { clearTimeout(timer); }
    if (controller.signal.aborted || Date.now() >= op.deadlineEpochMs || !process.connected) throw Error('operation ended after ownership cutoff');
    const path = join(job.privateRoot, `result-${job.identity.invocationId}-${index}.json`);
    const encoded = JSON.stringify(result ?? null);
    if (Buffer.byteLength(encoded) > 1024 * 1024) throw Error('private result too large');
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, encoded); fsyncSync(fd); } finally { closeSync(fd); }
    send({ type: 'result', phase: op.phase, path, sha256: hash(encoded) });
  }
} catch { send({ type: 'failure' }); }
// Parent owns group reap, including descendants and inherited pipes.
