import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpInvocation } from '@camerontaylor/cq-toolkit';
import { PiNativeDriver } from '../runner/native/pi.ts';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { InvocationIdentity } from '../runner/native/observation.ts';

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cq-pi-terminal-test-'));
  roots.push(root);
  return root;
}

function identity(id: string): InvocationIdentity {
  return { invocationId: id, assignmentId: `assignment-${id}`, stageId: 'draft', attemptId: `attempt-${id}` };
}

function invocation(wallClockMs = 10_000): OpInvocation {
  return {
    prompt: 'simulate a bounded Pi invocation',
    modelSpec: { model: 'opencode-go/space-bunny-free', provider: 'test-provider' },
    toolPolicy: { allow: [], mode: 'none' },
    sandboxPolicy: { level: 'workspace-write' },
    budget: { wallClockMs },
  };
}

function piMessage(): string {
  return `${JSON.stringify({ type: 'message_end', message: {
    id: 'final-message', role: 'assistant', stopReason: 'stop',
    usage: { input: 9, output: 2, cacheRead: 4, totalTokens: 15 },
    content: [{ type: 'text', text: 'format-mismatch' }],
  } })}\n`;
}

describe('Pi supervisor terminal precedence', () => {
  for (const terminal of ['timeout', 'cancelled', 'exit'] as const) {
    it(`keeps ${terminal} distinct after ready Pi output and clean child exit`, async () => {
      const root = tempRoot();
      const fakePid = 456_789_124;
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        pid: fakePid, stdout, stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => true),
      }) as unknown as ChildProcess;
      let ready!: () => void;
      const handoff = new Promise<void>((resolve) => { ready = resolve; });
      const driver = new PiNativeDriver({ executable: 'synthetic-pi', version: 'fixture-1',
        hardWallClockMs: 300, killGraceMs: 250, artifactDirectory: join(root, 'artifacts'),
        spawnAdapter: async () => {
          ready();
          return { child, boundaryIdentity: 'fixture', launchIdentity: 'fixture', admissionId: 'fixture',
            scope: 'visible-calibration', isolation: 'disabled', heldOut: false, environmentNames: [] };
        },
      });
      const target = identity(`pi-${terminal}-clean-exit`);
      await driver.beginInvocation(target);
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const execution = driver.run(invocation(300));
      await handoff;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const outputReady = new Promise<void>((resolve) => stdout.once('data', () => resolve()));
      stdout.write(piMessage());
      await outputReady;
      let signalled = false;
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number | null) => {
        if (pid !== -fakePid) throw new Error('unexpected process group');
        if (signal === 0) throw Object.assign(new Error('fixture absent'), { code: 'ESRCH' });
        if (signal === 'SIGTERM' || signal === 'SIGKILL') { signalled = true; child.emit('close', 0, signal); }
        return true;
      }) as typeof process.kill);
      if (terminal === 'timeout') await vi.advanceTimersByTimeAsync(300);
      else if (terminal === 'cancelled') {
        const proof = driver.cancelInvocationAndWait({ identity: target, cause: 'operator cancellation', deadlineEpochMs: Date.now() + 1_000 });
        await vi.advanceTimersByTimeAsync(0);
        expect(await proof).toMatchObject({ invocationId: target.invocationId, processTree: 'stopped-and-reaped', invocation: 'settled' });
      } else child.emit('close', 0, null);
      const result = await execution;
      const observation = driver.getObservation(target.invocationId)!;
      if (terminal !== 'exit') expect(signalled).toBe(true);
      expect(result.stopReason).toBe(terminal === 'timeout' ? 'budget' : terminal === 'cancelled' ? 'aborted' : 'complete');
      expect(result.structuredOutput).toBe('format-mismatch');
      expect(observation.terminal.cause).toBe(terminal === 'exit' ? null : terminal);
      expect(observation.terminal.cancelled).toBe(terminal === 'cancelled');
      expect(observation.model.settings.processTree).toMatchObject({ value: true, status: 'stopped-and-settled' });
      expect(observation.usage.counters.input).toMatchObject({ value: 9, availability: 'observed' });
      expect(observation.usage.counters.output).toMatchObject({ value: 2, availability: 'observed' });
      expect(observation.usage.counters.cacheRead).toMatchObject({ value: 4, availability: 'observed' });
      expect(observation.usage.counters.cacheWrite).toMatchObject({ value: null, availability: 'not-reported' });
      expect(observation.usage.tokenTotal).toMatchObject({ value: 15, availability: 'observed', semantics: 'authoritative-total' });
      expect(JSON.parse(readFileSync(observation.artifacts[0]!.path, 'utf8'))).toMatchObject({ type: 'message_end' });
    });
  }
});
