import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OpInvocation, WorkerResult } from '@camerontaylor/cq-toolkit';
import { CodexExecDriver } from '../runner/native/codex.ts';
import { PiNativeDriver } from '../runner/native/pi.ts';
import { ZcodeAcpDriver, assertOutsideGlmBlackout } from '../runner/native/zcode.ts';
import { runSupervised } from '../runner/native/process.ts';
import type { InvocationIdentity } from '../runner/native/observation.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cq-native-test-'));
  roots.push(root);
  return root;
}

function fakeExecutable(root: string, output: string, exit = 0): string {
  const file = join(root, 'fake-cli');
  const source = `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(output)});\nprocess.exit(${exit});\n`;
  writeFileSync(file, source, { mode: 0o700 });
  chmodSync(file, 0o700);
  return file;
}

function invocation(prompt = 'simulated task'): OpInvocation {
  return {
    prompt,
    modelSpec: { model: 'scaffold-default', provider: 'test-default' },
    toolPolicy: { allow: ['read', 'edit', 'run'], mode: 'allowlist' },
    sandboxPolicy: { level: 'workspace-write' },
    budget: { wallClockMs: 2_000 },
  };
}

function identity(id: string): InvocationIdentity {
  return { invocationId: id, assignmentId: `assignment-${id}`, stageId: 'draft', attemptId: `attempt-${id}` };
}

describe('native transport event and identity handling', () => {
  it('fails closed before native launch without a boundary admission', async () => {
    const root = tempRoot();
    const marker = join(root, 'launched');
    const executable = join(root, 'blocked-cli');
    writeFileSync(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched');\n`, { mode: 0o700 });
    chmodSync(executable, 0o700);
    const driver = new CodexExecDriver({ executable, version: 'fake-1', artifactDirectory: join(root, 'artifacts') });
    await driver.beginInvocation(identity('blocked'));
    await expect(driver.run(invocation())).rejects.toThrow(/boundary isolation and orchestrator admission/u);
    expect(existsSync(marker)).toBe(false);
    expect(driver.getObservation('blocked')?.terminal.transportException?.message).toMatch(/boundary isolation/u);
  });

  it('records Codex event usage, final output, artifacts, and concurrent identities independently', async () => {
    const root = tempRoot();
    const events = [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"fixed":true}' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 8, cached_input_tokens: 3 } }),
    ].join('\n') + '\n';
    const driver = new CodexExecDriver({ executable: fakeExecutable(root, events), version: 'fake-1', artifactDirectory: join(root, 'artifacts'), allowUnconfinedTestProcess: true });
    const runWithIdentity = async (id: string, prompt: string) => {
      await driver.beginInvocation(identity(id));
      return driver.run(invocation(prompt));
    };
    const [a, b] = await Promise.all([runWithIdentity('a', 'A'), runWithIdentity('b', 'B')]);
    expect((a.structuredOutput as { fixed: boolean }).fixed).toBe(true);
    expect(b.usage.input).toBe(20);
    for (const key of ['a', 'b']) {
      const observation = driver.getObservation(key)!;
      expect(observation.identity).toEqual(identity(key));
      expect(observation.model.requested).toMatchObject({ value: 'gpt-6-luna', status: 'requested' });
      expect(observation.usage.counters.input).toMatchObject({ value: 20, availability: 'observed' });
      expect(observation.artifacts).toHaveLength(1);
      expect(readFileSync(observation.artifacts[0]!.path, 'utf8')).toContain('turn.completed');
    }
  });

  it('keeps Space Bunny anonymous while preserving usage and response text', async () => {
    const root = tempRoot();
    const hidden = 'underlying-model-must-not-escape';
    const events = JSON.stringify({ type: 'message_end', message: {
      role: 'assistant', model: hidden, usage: { input: 7, output: 4 },
      content: [{ type: 'text', text: '{"answer":42}' }],
    } });
    const driver = new PiNativeDriver({ executable: fakeExecutable(root, `${events}\n`), artifactDirectory: join(root, 'artifacts'), allowUnconfinedTestProcess: true });
    await driver.beginInvocation(identity('pi'));
    const result = await driver.run(invocation());
    const observation = driver.getObservation('pi')!;
    expect(result.structuredOutput).toEqual({ answer: 42 });
    expect(observation.model.configuredTarget).toBe('pi-opencode/opencode-go/space-bunny-free');
    expect(observation.model.observed.value).toBeNull();
    expect(observation.model.requested).toMatchObject({ value: 'opencode-go/space-bunny-free', status: 'requested' });
    expect(readFileSync(observation.artifacts[0]!.path, 'utf8')).not.toContain(hidden);
    expect(observation.usage.counters.input.value).toBe(7);
  });

  it('preserves a ZCode ACP envelope around a simulated native result and refuses blackout dispatch', async () => {
    const root = tempRoot();
    const fake: Pick<{ run(input: OpInvocation): Promise<WorkerResult> }, 'run'> = {
      async run() { return { model: 'GLM-5.3-Flash', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, denials: [], stopReason: 'complete' }; },
    };
    const driver = new ZcodeAcpDriver({ driver: fake, sessionsDirectory: join(root, 'sessions'), workspaceForInvocation: () => root });
    await driver.beginInvocation(identity('zcode'));
    const result = await driver.run(invocation());
    expect(result.stopReason).toBe('complete');
    expect(driver.getObservation('zcode')).toMatchObject({
      transport: 'zcode-acp', model: {
        requested: { value: 'GLM-5.3-Flash', status: 'requested' },
        observed: { value: 'GLM-5.3-Flash', status: 'observed' },
      },
      usage: { counters: { input: { value: null, availability: 'not-reported' } } },
    });
    expect(() => assertOutsideGlmBlackout(new Date('2026-09-29T07:00:00Z'))).toThrow(/blackout/u);
    expect(() => assertOutsideGlmBlackout(new Date('2026-09-29T02:00:00Z'))).not.toThrow();
  });
});

describe('supervised native subprocesses', () => {
  it('returns a hard timeout and cleans up a descendant in the process group', async () => {
    if (process.platform === 'win32') return;
    const root = tempRoot();
    const marker = join(root, 'survived');
    const descendant = [
      "const fs=require('node:fs');",
      "process.on('SIGTERM',()=>{});",
      `setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'alive'),500);`,
    ].join('');
    const parent = [
      "const {spawn}=require('node:child_process');",
      `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});`,
      'setInterval(()=>{},1000);',
    ].join('');
    const script = join(root, 'parent.cjs');
    writeFileSync(script, parent);
    const result = await runSupervised(process.execPath, [script], { cwd: root, timeoutMs: 80, killGraceMs: 60, allowUnconfinedTestProcess: true });
    expect(result.terminal).toBe('timeout');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(existsSync(marker)).toBe(false);
  });

  it('keeps partial stdout and labels an abort as cancelled', async () => {
    const root = tempRoot();
    const script = join(root, 'partial.cjs');
    writeFileSync(script, "process.stdout.write('partial\\n'); setInterval(()=>{},1000);");
    const controller = new AbortController();
    const pending = runSupervised(process.execPath, [script], {
      cwd: root, timeoutMs: 2_000, signal: controller.signal,
      allowUnconfinedTestProcess: true,
      onStdout: () => controller.abort(),
    });
    const result = await pending;
    expect(result.terminal).toBe('cancelled');
    expect(result.stdout).toContain('partial');
  });
});
