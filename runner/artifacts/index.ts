import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ExperimentContext } from '../experiment.ts';
import type { NativeObservation } from '../native/observation.ts';

export interface ImmutableArtifactRef { path: string; sha256: string; }

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Namespaces every attempt, then atomically refuses any pre-existing path. */
export class ArtifactStore {
  readonly root: string;
  constructor(root: string) {
    mkdirSync(resolve(root), { recursive: true });
    const requestedRoot = resolve(root);
    const rootStat = lstatSync(requestedRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('artifact root must be a real directory');
    this.root = realpathSync(requestedRoot);
  }

  attemptDirectory(context: ExperimentContext): string {
    const segments = [context.campaignId, context.cohortId, context.experimentId, context.taskId,
      context.repeatId, context.assignmentId, context.stageId, context.attemptId];
    if (segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) {
      throw new Error('artifact identity contains an unsafe path segment');
    }
    return join(this.root, 'campaign', context.campaignId, 'cohort', context.cohortId,
      'experiment', context.experimentId, 'task', context.taskId, 'repeat', context.repeatId,
      'assignment', context.assignmentId, 'stage', context.stageId, 'attempt', context.attemptId);
  }

  write(context: ExperimentContext, name: string, content: string | Buffer): ImmutableArtifactRef {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`unsafe artifact name: ${name}`);
    const base = this.attemptDirectory(context);
    const path = resolve(base, name);
    if (!path.startsWith(`${base}/`)) throw new Error('artifact path escaped attempt namespace');
    this.ensureDirectory(base);
    this.quarantineOrphanTemps(base);
    const payload = typeof content === 'string' ? Buffer.from(content) : content;
    const digest = sha256(payload);
    try { this.atomicCreate(path, payload); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`immutable artifact already exists: ${relative(this.root, path)}`);
      throw error;
    }
    const rel = relative(this.root, path);
    const manifestDir = join(this.root, '.manifests');
    this.ensureDirectory(manifestDir);
    const manifestPath = join(manifestDir, `${sha256(rel)}.json`);
    this.atomicCreate(manifestPath, `${JSON.stringify({ path: rel, sha256: digest, bytes: payload.length })}\n`);
    return { path: rel, sha256: digest };
  }

  private ensureDirectory(path: string): void {
    const rel = relative(this.root, resolve(path));
    if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(path) !== this.root && !resolve(path).startsWith(`${this.root}${sep}`)) {
      throw new Error('artifact directory escaped root');
    }
    let current = this.root;
    for (const segment of rel.split(sep).filter(Boolean)) {
      current = join(current, segment);
      try { mkdirSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const st = lstatSync(current);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`artifact path contains a non-directory or symlink: ${relative(this.root, current)}`);
      const actual = realpathSync(current);
      if (actual !== this.root && !actual.startsWith(`${this.root}${sep}`)) throw new Error('artifact path escaped root through symlink');
    }
  }

  private atomicCreate(path: string, content: string | Buffer): void {
    const temp = join(dirname(path), `.cq-tmp-${randomUUID()}`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, content);
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      linkSync(temp, path); // atomic create-if-absent; never replaces a prior artifact
      unlinkSync(temp);
      const dirFd = openSync(dirname(path), 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch { /* linked or absent */ }
    }
  }

  private quarantineOrphanTemps(directory: string): void {
    const quarantine = join(this.root, '.quarantine');
    for (const name of readdirSync(directory)) {
      if (!name.startsWith('.cq-tmp-')) continue;
      const source = join(directory, name);
      const st = lstatSync(source);
      if (st.isSymbolicLink() || !st.isFile() || Date.now() - st.mtimeMs < 60_000) continue;
      this.ensureDirectory(quarantine);
      const destination = join(quarantine, `${randomUUID()}.orphan`);
      const bytes = readFileSync(source);
      renameSync(source, destination);
      this.atomicCreate(`${destination}.json`, `${JSON.stringify({ original: relative(this.root, source), path: relative(this.root, destination), sha256: sha256(bytes), bytes: bytes.length })}\n`);
    }
  }

  writeObservation(context: ExperimentContext, observation: NativeObservation): ImmutableArtifactRef {
    return this.write(context, 'observation.json', `${JSON.stringify(observation, null, 2)}\n`);
  }

  writeJudgement(context: ExperimentContext, judgementId: string, candidateSha256: string, judgePin: string, judgement: unknown): ImmutableArtifactRef {
    const payload = `${JSON.stringify({ judgementId, candidateSha256, judgePin, judgement }, null, 2)}\n`;
    return this.write(context, `judgement-${judgementId}.json`, payload);
  }
}
