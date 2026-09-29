import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

/** Copy only named plain candidate modules into a disposable, non-Git child input. */
export async function withProtectedCandidateSnapshot<T>(
  candidateRoot: string,
  modules: readonly string[],
  run: (candidateRoot: string) => Promise<T>,
): Promise<T> {
  const sourceRoot = resolve(candidateRoot);
  const scratchRoot = mkdtempSync(join(tmpdir(), 'cq-protected-candidate-'));
  try {
    for (const module of modules) {
      if (!module || module.startsWith('/') || module.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error('safe candidate module path required');
      }
      const source = join(sourceRoot, module);
      const stat = lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('plain candidate module required');
      const destination = join(scratchRoot, module);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, readFileSync(source), { flag: 'wx', mode: 0o600 });
      if (relative(scratchRoot, destination).startsWith('..')) throw new Error('candidate path escaped snapshot');
    }
    return await run(scratchRoot);
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}
