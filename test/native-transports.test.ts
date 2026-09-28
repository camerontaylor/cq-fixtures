import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore, type OpInvocation, type WorkerResult } from '@camerontaylor/cq-toolkit';
import { CodexExecDriver } from '../runner/native/codex.ts';
import { PiNativeDriver } from '../runner/native/pi.ts';
import { ZcodeAcpDriver, assertOutsideGlmBlackout } from '../runner/native/zcode.ts';
import { runSupervised, visibleCalibrationSpawnAdapter } from '../runner/native/process.ts';
import { parseJsonEventLines, applyUsageObservation } from '../runner/native/events.ts';
import { unavailableObservation, type InvocationIdentity } from '../runner/native/observation.ts';
import { RUNNER_SESSION_DIRECTORY } from '../runner/native/session.ts';
import { ObservedNativeDriver, createWorkerResult } from '../runner/native/observed-driver.ts';
import { runVisibleG1, visibleG1TestInventory } from '../runner/native/run-visible-g1.ts';
import type { LaunchProfile } from '../runner/native/launch-inventory.ts';

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

function invocation(prompt = 'simulated task', model = 'gpt-6-luna'): OpInvocation {
  return {
    prompt,
    modelSpec: { model, provider: 'test-provider' },
    toolPolicy: { allow: ['read', 'edit', 'run'], mode: 'allowlist' },
    sandboxPolicy: { level: 'workspace-write' },
    budget: { wallClockMs: 2_000 },
  };
}

function identity(id: string): InvocationIdentity {
  return { invocationId: id, assignmentId: `assignment-${id}`, stageId: 'draft', attemptId: `attempt-${id}` };
}

function simulatedVisibleLaunch() {
  return visibleCalibrationSpawnAdapter({ admissionId: 'test-admission-only', scope: 'visible-calibration', isolation: 'disabled', heldOut: false, environmentNames: ['PATH'] });
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
    const driver = new CodexExecDriver({ executable: fakeExecutable(root, events), version: 'fake-1', artifactDirectory: join(root, 'artifacts'), spawnAdapter: simulatedVisibleLaunch() });
    const runWithIdentity = async (id: string, prompt: string) => {
      await driver.beginInvocation(identity(id));
      return driver.run(invocation(prompt, 'gpt-6-luna'));
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
      id: 'msg-final', role: 'assistant', stopReason: 'stop', model: hidden, usage: { input: 7, output: 4 },
      content: [{ type: 'text', text: '{"answer":42}' }],
    } });
    const driver = new PiNativeDriver({ executable: fakeExecutable(root, `${events}\n`), artifactDirectory: join(root, 'artifacts'), spawnAdapter: simulatedVisibleLaunch() });
    await driver.beginInvocation(identity('pi'));
    const result = await driver.run(invocation('simulated task', 'opencode-go/space-bunny-free'));
    const observation = driver.getObservation('pi')!;
    expect(result.structuredOutput).toEqual({ answer: 42 });
    expect(observation.model.configuredTarget).toBe('pi-opencode/opencode-go/space-bunny-free');
    expect(observation.model.observed.value).toBeNull();
    expect(observation.model.requested).toMatchObject({ value: 'opencode-go/space-bunny-free', status: 'requested' });
    expect(readFileSync(observation.artifacts[0]!.path, 'utf8')).not.toContain(hidden);
    expect(observation.usage.counters.input.value).toBe(7);
  });

  it('folds distinct Pi assistant responses once, preserves reported totals, and selects only the terminal answer', () => {
    const toolTurn = { id: 'msg-tool', role: 'assistant', stopReason: 'toolUse', usage: { input: 10, output: 2, cacheRead: 5, totalTokens: 17 }, content: [{ type: 'text', text: 'intermediate, not JSON' }] };
    const finalTurn = { id: 'msg-final', role: 'assistant', stopReason: 'stop', usage: { input: 6, output: 4, cacheRead: 2, totalTokens: 12 }, content: [{ type: 'text', text: '{"answer":true}' }] };
    const raw = [
      { type: 'message_end', message: toolTurn },
      { type: 'agent_end', messages: [toolTurn] },
      { type: 'message_end', message: finalTurn },
      { type: 'agent_end', messages: [toolTurn, finalTurn] },
    ].map((event) => JSON.stringify(event)).join('\n');
    const parsed = parseJsonEventLines(raw, 'pi');
    expect(parsed.finalText).toBe('{"answer":true}');
    expect(parsed.usage).toMatchObject({ input: 16, output: 6, cacheRead: 7, tokenTotal: 29 });
  });

  it('uses Codex source total without adding cached-input subsets or inventing absent cache-write usage', () => {
    const parsed = parseJsonEventLines(JSON.stringify({ type: 'turn.completed', turn_id: 'turn-1', usage: {
      input_tokens: 20, output_tokens: 10, cached_input_tokens: 8, total_tokens: 30,
    } }), 'codex');
    expect(parsed.usage).toMatchObject({ input: 20, output: 10, cacheRead: 8, tokenTotal: 30 });
    expect(parsed.usage.cacheWrite).toBeUndefined();
    const observation = unavailableObservation(identity('codex-usage'), 'codex-exec', null);
    applyUsageObservation(observation, parsed, 'codex-json');
    expect(observation.usage.tokenTotal).toMatchObject({ value: 30, availability: 'observed' });
    expect(observation.usage.counters.cacheWrite.availability).toBe('unavailable');
  });

  it('preserves measured Codex events when the process fails after emitting them', async () => {
    const root = tempRoot();
    const partial = `${JSON.stringify({ type: 'turn.completed', turn_id: 'partial-turn', usage: {
      input_tokens: 11, output_tokens: 3, total_tokens: 14,
    } })}\n`;
    const driver = new CodexExecDriver({ executable: fakeExecutable(root, partial, 7), artifactDirectory: join(root, 'artifacts'), spawnAdapter: simulatedVisibleLaunch() });
    await driver.beginInvocation(identity('failed-after-events'));
    const result = await driver.run(invocation());
    expect(result.stopReason).toBe('error');
    expect(result.error).toContain('exited 7');
    const observation = driver.getObservation('failed-after-events')!;
    expect(observation.usage.counters.input.value).toBe(11);
    expect(observation.usage.tokenTotal.value).toBe(14);
    expect(observation.artifacts).toHaveLength(1);
  });

  it('resolves the runner sessionRef workspace for a Codex ephemeral CLI launch', async () => {
    const root = tempRoot();
    const store = new SessionStore(RUNNER_SESSION_DIRECTORY);
    const session = await store.create(root);
    const events = `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } })}\n`;
    const executable = join(root, 'fake-cli');
    writeFileSync(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(join(root, 'cwd.txt'))}, process.cwd());\nprocess.stdout.write(${JSON.stringify(events)});\n`, { mode: 0o700 });
    chmodSync(executable, 0o700);
    const driver = new CodexExecDriver({ executable, artifactDirectory: join(root, 'artifacts'), spawnAdapter: simulatedVisibleLaunch(), workspaceForInvocation: () => root });
    await driver.beginInvocation(identity('session-bound'));
    const result = await driver.run({ ...invocation('task', 'gpt-6-luna'), sessionRef: session.sessionId });
    expect(readFileSync(join(root, 'cwd.txt'), 'utf8')).toBe(root);
    expect(result.sessionId).toBe(session.sessionId);
    expect(driver.getObservation('session-bound')?.model.settings.session).toMatchObject({ status: 'runner-workspace-resolved' });
    unlinkSync(join(RUNNER_SESSION_DIRECTORY, `${session.sessionId}.jsonl`));
  });

  it('returns stage-matched native stop proof only after cancellation settles and the process group is gone', async () => {
    if (process.platform === 'win32') return;
    const root = tempRoot();
    const script = join(root, 'hanging-cli');
    const child = `process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`;
    const source = `#!/usr/bin/env node\nconst {spawn}=require('node:child_process'); spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'}); process.stdout.write('partial\\n'); setInterval(()=>{},1000);\n`;
    writeFileSync(script, source, { mode: 0o700 });
    chmodSync(script, 0o700);
    const driver = new CodexExecDriver({ executable: script, artifactDirectory: join(root, 'artifacts'), spawnAdapter: simulatedVisibleLaunch(), killGraceMs: 80 });
    const invocationIdentity = identity('cancel-proof');
    await driver.beginInvocation(invocationIdentity);
    const execution = driver.run(invocation());
    const proof = await driver.cancelInvocationAndWait({ identity: invocationIdentity, cause: 'stage deadline', deadlineEpochMs: Date.now() + 3_000 });
    const result = await execution;
    expect(proof).toEqual({ invocationId: 'cancel-proof', stageId: 'draft', attemptId: 'attempt-cancel-proof', processTree: 'stopped-and-reaped', invocation: 'settled' });
    expect(result.stopReason).toBe('aborted');
    expect(driver.getObservation('cancel-proof')?.model.settings.processTree).toMatchObject({ value: true, status: 'stopped-and-settled' });
    await expect(driver.cancelInvocationAndWait({ identity: { ...invocationIdentity, stageId: 'wrong-stage' }, cause: 'bad proof', deadlineEpochMs: Date.now() + 100 })).rejects.toThrow(/no matching invocation/u);
  });

  it('preserves a ZCode ACP envelope around a simulated native result and refuses blackout dispatch', async () => {
    const root = tempRoot();
    const fake: Pick<{ run(input: OpInvocation): Promise<WorkerResult> }, 'run'> = {
      async run() { return { model: 'GLM-5.3-Flash', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, denials: [], stopReason: 'complete' }; },
    };
    const driver = new ZcodeAcpDriver({ driver: fake, sessionsDirectory: join(root, 'sessions'), workspaceForInvocation: () => root });
    await driver.beginInvocation(identity('zcode'));
    const result = await driver.run(invocation('simulated task', 'GLM-5.3-Flash'));
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
  it('rejects unpinned proxy or provider endpoint overrides for visible calibration', () => {
    expect(() => visibleCalibrationSpawnAdapter({ admissionId: 'test', scope: 'visible-calibration', isolation: 'disabled', heldOut: false, environmentNames: ['HTTPS_PROXY'] })).toThrow(/cannot override provider or proxy endpoints/u);
  });

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

describe('visible G1 runSuite entrypoint', () => {
  it('records actual schema rows, comparison tables, host oracle pins, and simulated native observations', async () => {
    const root = tempRoot();
    class SimulatedCodexDriver extends ObservedNativeDriver {
      constructor() {
        super({ configuredTarget: 'codex/gpt-6-luna', transport: 'codex-exec', executable: 'simulated-codex', executableVersion: 'test', profile: 'visible-test' });
      }
      protected async runObserved(input: OpInvocation, invocationIdentity: InvocationIdentity): Promise<WorkerResult> {
        const workspace = input.prompt.match(/^workspace: (.+)$/mu)?.[1];
        if (!workspace) throw new Error('simulated runSuite invocation omitted workspace');
        writeFileSync(join(workspace, 'src/settings.mjs'), `export function isValidCampaignLabel(label) {\n  const value = typeof label === 'string' ? label.trim() : '';\n  return value.length > 0 && Array.from(value).length <= 40;\n}\n`);
        const observation = this.newObservation(invocationIdentity, input, new Date().toISOString());
        observation.model.observed = { value: 'gpt-6-luna', source: 'simulated native event', status: 'observed' };
        observation.model.settings.launch = {
          value: { scope: 'visible-calibration', isolation: 'disabled', heldOut: false },
          source: 'simulated parent admission receipt', status: 'observed',
        };
        const result = createWorkerResult({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 'complete', {
          model: 'gpt-6-luna', structuredOutput: { fixed: true, notes: 'bounded Unicode length validation' },
        });
        this.finishObservation(observation, result);
        return result;
      }
    }
    const configured: LaunchProfile = {
      label: 'Codex Sol fullaccess', executable: process.execPath, version: 'test', args: [], envKeys: [],
      cwdBehavior: 'runner workspace', providerRoute: 'codex', requestedModel: 'gpt-6-luna', authClass: 'subscription',
      effort: 'low', permissionPolicy: 'fullaccess', sandboxPolicy: 'none', systemContext: [], tools: [], extensions: [],
      assistance: [], sessionBehavior: 'ephemeral', feedbackBehavior: null,
    };
    const result = await runVisibleG1({
      route: 'codex', driver: new SimulatedCodexDriver(),
      boundary: { scope: 'visible-calibration', isolation: 'disabled', heldOut: false, evidenceRef: 'synthetic-test-receipt' },
      outputRoot: root, launchInventory: visibleG1TestInventory(configured), quotaSource: { async refresh() { return null; } },
    });
    const report = JSON.parse(readFileSync(result.reportPath, 'utf8')) as {
      status: string; experimentId: string; boundary: { status: string; heldOut: boolean };
      profileComparison: { status: string }; task: { oraclePin: { sha256: string }; pinnedBaselineCommits: Array<{ commit: string; tree: string | null }> };
      rows: unknown[]; tables: unknown[]; observations: Array<{ observation: { capture: { baselineCommit: string | null; baselineTree?: string | null } } }>;
      budget: { maxAttempts: number; maxTokens: number | null; hardTokenCap: boolean };
    };
    expect(report.status).toBe('complete');
    expect(report.experimentId).toBe(result.experimentId);
    expect(report.boundary).toMatchObject({ status: 'visible-only-unconfined', heldOut: false });
    expect(report.profileComparison.status).toBe('intentionally-altered');
    expect(report.task.oraclePin.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.task.pinnedBaselineCommits[0]?.commit).toMatch(/^[a-f0-9]{40}$/u);
    expect(report.observations[0]?.observation.capture.baselineCommit).toMatch(/^[a-f0-9]{40}$/u);
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.tables.length).toBeGreaterThan(0);
    expect(report.rows).toContainEqual(expect.objectContaining({
      driver: 'codex-exec', outcome: expect.objectContaining({ score: 1 }),
    }));
    expect(report.tables.flatMap((table: unknown) => (table as { cells?: unknown[] }).cells ?? []))
      .toContainEqual(expect.objectContaining({ driver: 'codex-exec' }));
    expect(report.budget).toMatchObject({ maxAttempts: 1, maxTokens: null, hardTokenCap: false });
  }, 90_000);
});
