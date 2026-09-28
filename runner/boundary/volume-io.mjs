// Trusted utility only, fixed /task mount. Never follow links or inspect other roots.
import fs from 'node:fs';
import path from 'node:path';
const limit = 64 * 1024 * 1024;
if (process.argv[1] === 'read') {
  const entries = []; let bytes = 0;
  function walk(relative) {
    const root = path.join('/task', relative);
    if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error('changed directory');
    for (const name of fs.readdirSync(root).sort()) {
      const p = relative ? relative + '/' + name : name; const a = path.join('/task', p); const s = fs.lstatSync(a);
      if (s.mode & 0o7000) throw new Error('special mode bits forbidden');
      if (entries.length >= 12000) throw new Error('file limit');
      if (s.isDirectory()) { entries.push({ path: p, kind: 'directory', mode: s.mode & 0o777 }); walk(p); }
      else if (s.isSymbolicLink()) entries.push({ path: p, kind: 'symlink', mode: s.mode & 0o777, target: fs.readlinkSync(a) });
      else if (s.isFile()) {
        bytes += s.size; if (bytes > limit || s.nlink > 1) throw new Error('bytes/hardlink limit');
        const fd = fs.openSync(a, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { const actual = fs.fstatSync(fd); if (actual.ino !== s.ino || actual.dev !== s.dev) throw new Error('file changed');
          entries.push({ path: p, kind: 'file', mode: s.mode & 0o777, data: fs.readFileSync(fd).toString('base64') });
        } finally { fs.closeSync(fd); }
      } else throw new Error('special file');
    }
  }
  walk(''); console.log(JSON.stringify(entries));
} else if (process.argv[1] === 'write') {
  let text = ''; for await (const chunk of process.stdin) { text += chunk; if (text.length > 100 * 1024 * 1024) throw new Error('packet limit'); }
  const entries = JSON.parse(text); if (!Array.isArray(entries) || entries.length > 12000 || fs.readdirSync('/task').length) throw new Error('fresh volume required');
  const seen = new Map(); let bytes = 0;
  // Validate every ancestor BEFORE writing; never open through a symlink.
  for (const e of entries) {
    if (!e.path || e.path.startsWith('/') || e.path.includes('\\') || e.path.includes('\0') || e.path.split('/').some(p => !p || p === '.' || p === '..') || seen.has(e.path)) throw new Error('unsafe entry');
    const parent = path.posix.dirname(e.path); if (parent !== '.' && seen.get(parent) !== 'directory') throw new Error('unsafe ancestor');
    if (!['file', 'directory', 'symlink'].includes(e.kind) || !Number.isInteger(e.mode) || (e.mode & ~0o777) !== 0) throw new Error('unsafe kind/mode');
    if (e.kind === 'file') { bytes += Buffer.from(e.data, 'base64').length; if (bytes > limit) throw new Error('bytes limit'); }
    if (e.kind === 'symlink') { const target = path.posix.normalize(path.posix.join(parent, e.target)); if (!e.target || e.target.startsWith('/') || target === '..' || target.startsWith('../')) throw new Error('escaping link'); }
    seen.set(e.path, e.kind);
  }
  for (const e of entries) {
    const p = path.join('/task', e.path);
    if (e.kind === 'directory') fs.mkdirSync(p, { mode: 0o700 });
    else if (e.kind === 'file') fs.writeFileSync(p, Buffer.from(e.data, 'base64'), { flag: 'wx', mode: e.mode });
    else fs.symlinkSync(e.target, p);

  }
  for (const e of [...entries].reverse()) { const p = path.join('/task', e.path); if (e.kind !== 'symlink') fs.chmodSync(p, e.mode); fs.lchownSync(p, 1000, 1000); }
  fs.chownSync('/task', 1000, 1000); console.log('{"staged":true}');
} else throw new Error('undeclared operation');
