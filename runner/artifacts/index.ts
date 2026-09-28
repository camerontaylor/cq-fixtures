import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { ExperimentContext } from '../experiment.ts';
import type { NativeObservation } from '../native/observation.ts';

export interface ImmutableArtifactRef { path: string; sha256: string; }

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Namespaces every attempt, then atomically refuses any pre-existing path. */
export class ArtifactStore {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

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
    mkdirSync(dirname(path), { recursive: true });
    try { writeFileSync(path, content, { flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`immutable artifact already exists: ${relative(this.root, path)}`);
      throw error;
    }
    return { path: relative(this.root, path), sha256: sha256(content) };
  }

  writeObservation(context: ExperimentContext, observation: NativeObservation): ImmutableArtifactRef {
    return this.write(context, 'observation.json', `${JSON.stringify(observation, null, 2)}\n`);
  }

  writeJudgement(context: ExperimentContext, judgementId: string, candidateSha256: string, judgePin: string, judgement: unknown): ImmutableArtifactRef {
    const payload = `${JSON.stringify({ judgementId, candidateSha256, judgePin, judgement }, null, 2)}\n`;
    return this.write(context, `judgement-${judgementId}.json`, payload);
  }
}
