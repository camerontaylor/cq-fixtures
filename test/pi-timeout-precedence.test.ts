import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OpInvocation } from '@camerontaylor/cq-toolkit';
import { PiNativeDriver } from '../runner/native/pi.ts';
import { visibleCalibrationSpawnAdapter } from '../runner/native/process.ts';
import type { InvocationIdentity } from '../runner/native/observation.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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

function signalHandlingPi(root: string): { executable: string; signalled: string } {
  const executable = join(root, 'fake-pi-handles-term');
  const signalled = join(root, 'sigterm-received');
  const source = `#!/usr/bin/env node\n` +
    `const fs=require('node:fs');\n` +
    `process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(signalled)},'yes');process.exit(0);});\n` +
    `process.stdout.write(${JSON.stringify(piMessage())});\n` +
    `setInterval(()=>{},1000);\n`;
  writeFileSync(executable, source, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return { executable, signalled };
}

function driverFor(executable: string, hardWallClockMs: number): PiNativeDriver {
  return new PiNativeDriver({
    executable, hardWallClockMs, killGraceMs: 250,
    artifactDirectory: join(executable, '..', 'artifacts'),
    spawnAdapter: visibleCalibrationSpawnAdapter({
      admissionId: 'pi-terminal-regression', scope: 'visible-calibration', isolation: 'disabled', heldOut: false, environmentNames: ['PATH'],
    }),
  });
}

describe('Pi supervisor terminal precedence', () => {
  it('keeps timeout as budget after Pi handles SIGTERM with exit 0 and retains response evidence', async () => {
    const root = tempRoot();
    const fake = signalHandlingPi(root);
    const driver = driverFor(fake.executable, 300);
    await driver.beginInvocation(identity('pi-timeout-clean-exit'));
    const result = await driver.run(invocation(300));
    const observation = driver.getObservation('pi-timeout-clean-exit')!;

    expect(existsSync(fake.signalled)).toBe(true);
    expect(result.stopReason).toBe('budget');
    expect(result.structuredOutput).toBe('format-mismatch');
    expect(observation.terminal.cause).toBe('timeout');
    expect(observation.workerResult?.stopReason).toBe('budget');
    expect(observation.model.settings.processTree).toMatchObject({ value: true, status: 'stopped-and-settled' });
    expect(observation.usage.counters.input).toMatchObject({ value: 9, availability: 'observed' });
    expect(observation.usage.counters.output).toMatchObject({ value: 2, availability: 'observed' });
    expect(observation.usage.counters.cacheRead).toMatchObject({ value: 4, availability: 'observed' });
    expect(observation.usage.counters.cacheWrite).toMatchObject({ value: null, availability: 'not-reported' });
    expect(observation.usage.tokenTotal).toMatchObject({ value: 15, availability: 'observed', semantics: 'authoritative-total' });
    expect(JSON.parse(readFileSync(observation.artifacts[0]!.path, 'utf8'))).toMatchObject({ type: 'message_end' });
  }, 10_000);

});
