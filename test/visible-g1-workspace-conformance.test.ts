import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiNativeDriver } from '../runner/native/pi.ts';
import { visibleCalibrationSpawnAdapter } from '../runner/native/process.ts';
import { parseVisiblePiModelWallClockMs, runVisibleG1, visibleG1TestInventory } from '../runner/native/run-visible-g1.ts';
import type { LaunchProfile } from '../runner/native/index.ts';
import type { NativeObservation } from '../runner/native/observation.ts';
import type { WorkspaceConformanceReceipt } from '../runner/native/workspace-conformance.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(scenario: 'complete' | 'timeout', modelWallClockMs: number) {
  const root = mkdtempSync(join(tmpdir(), 'cq-visible-pi-workspace-'));
  roots.push(root);
  const executable = join(root, 'fake-pi');
  const event = JSON.stringify({
    type: 'message_end',
    message: {
      id: 'safe-fixture-response', role: 'assistant', stopReason: 'stop',
      usage: { input: 7, output: 2 },
      content: [{ type: 'text', text: JSON.stringify({ fixed: true, notes: 'bounded fixture repair' }) }],
    },
  });
  const completion = scenario === 'timeout'
    ? `process.stdout.write(${JSON.stringify(`${event}\n`)}); setInterval(() => {}, 1000);`
    : `process.stdout.write(${JSON.stringify(`${event}\n`)});`;
  writeFileSync(executable, `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.writeFileSync('settings/module.js', ${JSON.stringify(
    `export function isValidCampaignLabel(label) {\n  const value = typeof label === 'string' ? label.trim() : '';\n  return value.length > 0 && Array.from(value).length <= 40;\n}\n`,
  )});\n${completion}\n`, { mode: 0o700 });
  chmodSync(executable, 0o700);

  const launchProfile: LaunchProfile = {
    label: 'Pi Space Bunny configured profile', executable, version: 'fixture-1', args: [], envKeys: [],
    cwdBehavior: 'runner workspace', providerRoute: 'pi-opencode opencode-go',
    requestedModel: 'opencode-go/space-bunny-free', authClass: 'subscription', effort: 'high',
    permissionPolicy: 'fixture profile', sandboxPolicy: 'unknown', systemContext: [], tools: [], extensions: [],
    assistance: [], sessionBehavior: 'ephemeral', feedbackBehavior: null,
  };
  const driver = new PiNativeDriver({
    executable, version: 'fixture-1', profile: launchProfile.label, provider: 'opencode-go',
    model: 'opencode-go/space-bunny-free', thinking: 'high', hardWallClockMs: modelWallClockMs,
    artifactDirectory: join(root, 'native-events'),
    spawnAdapter: visibleCalibrationSpawnAdapter({
      admissionId: `fixture-visible-pi-${scenario}`, scope: 'visible-calibration', isolation: 'disabled',
      heldOut: false, environmentNames: ['PATH'],
    }),
  });
  return { root, driver, launchInventory: visibleG1TestInventory(launchProfile, 'pi-json') };
}

describe('visible Pi runSuite workspace conformance', () => {
  it('parses only bounded decimal cutoffs and rejects overrides on non-Pi routes before setup', async () => {
    expect(parseVisiblePiModelWallClockMs('1000')).toBe(1_000);
    expect(parseVisiblePiModelWallClockMs('120000')).toBe(120_000);
    for (const value of ['', '999', '120001', '1e3', '1000.0', 'NaN', 'Infinity', '-1000']) {
      expect(() => parseVisiblePiModelWallClockMs(value)).toThrow(/1000 to 120000/u);
    }
    const env = fixture('complete', 1_000);
    await expect(runVisibleG1({
      route: 'codex', driver: env.driver,
      boundary: { scope: 'visible-calibration', isolation: 'disabled', heldOut: false, evidenceRef: 'fixture' },
      outputRoot: env.root, modelWallClockMs: 1_000,
    })).rejects.toThrow(/only for pi-json and pi-rpc/u);
  });

  it('records assigned/control separation, lifecycle refs, and nullable usage for a normal fake Pi child', async () => {
    const env = fixture('complete', 10_000);
    const result = await runVisibleG1({
      route: 'pi-json', driver: env.driver,
      boundary: { scope: 'visible-calibration', isolation: 'disabled', heldOut: false, evidenceRef: 'fixture-admission' },
      outputRoot: env.root, launchInventory: env.launchInventory, modelWallClockMs: 10_000,
      quotaSource: { async refresh() { return null; } },
    });
    const report = JSON.parse(readFileSync(result.reportPath, 'utf8')) as {
      workspaceConformance: { receipt: WorkspaceConformanceReceipt; artifact: { path: string; sha256: string } };
      rows: unknown[]; tables: unknown[]; observations: Array<{ observation: NativeObservation }>;
      pins: { sourcePins: Record<string, string> };
      modelWallClockMs: number; budget: { wallClockMs: number; modelWallClockMs: number | null };
    };
    const receipt = report.workspaceConformance.receipt;
    expect(receipt).toMatchObject({ status: 'passed', workspaceSeparationStatus: 'passed', lifecycle: { qualification: 'qualified', processStatus: 'stopped', settlementStatus: 'settled' } });
    expect(receipt.workspaces.assigned.identitySha256).not.toBe(receipt.workspaces.control.identitySha256);
    expect(receipt.workspaces.control.unchanged).toBe(true);
    expect(receipt.workspaces.control.before).toEqual(receipt.workspaces.control.afterWorker);
    expect(receipt.workspaces.control.before).toEqual(receipt.workspaces.control.afterRunSuite);
    expect(receipt.lifecycle.processEvidence).toEqual(receipt.lifecycle.settlementEvidence);
    expect(receipt.lifecycle.processEvidence).toEqual(expect.objectContaining({ kind: 'native-lifecycle', sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }));
    expect(receipt.identity.invocationId).toBe(report.observations[0]!.observation.identity.invocationId);
    expect(report.observations[0]!.observation.artifacts).toContainEqual(receipt.lifecycle.processEvidence);
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.tables.length).toBeGreaterThan(0);
    const usage = report.observations[0]!.observation.usage;
    expect(usage.counters.input).toMatchObject({ value: 7, availability: 'observed' });
    expect(usage.counters.output).toMatchObject({ value: 2, availability: 'observed' });
    expect(usage.counters.cacheRead).toMatchObject({ value: null, availability: 'not-reported' });
    expect(usage.counters.cacheWrite).toMatchObject({ value: null, availability: 'not-reported' });
    expect(usage.counters.reasoning).toMatchObject({ value: null, availability: 'not-reported' });
    expect(usage.tokenTotal).toMatchObject({ value: null, availability: 'not-reported' });
    expect(report.pins.sourcePins).toHaveProperty('runner/native/workspace-conformance.ts');
    expect(report.pins.sourcePins).toHaveProperty('runner/native/visible-g1-pi-driver.ts');
    expect(report.pins.sourcePins).toHaveProperty('runner/native/pi.ts');
    expect(report.pins.sourcePins).toHaveProperty('runner/artifacts/index.ts');
    expect(report.pins.sourcePins).toHaveProperty('runner/experiment.ts');
    expect(report.pins.sourcePins['runner/native/workspace-conformance.ts']).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.workspaceConformance.artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.modelWallClockMs).toBe(10_000);
    expect(report.budget).toMatchObject({ wallClockMs: 240_000, modelWallClockMs: 10_000, judgeWallClockMs: 60_000 });
    expect(report.observations[0]!.observation.model.settings.launch?.value).toMatchObject({
      admissionId: 'fixture-visible-pi-complete', scope: 'visible-calibration', isolation: 'disabled', heldOut: false,
    });
  }, 30_000);

  it('retains qualified workspace/lifecycle evidence and measured nullable usage after fake Pi timeout', async () => {
    const env = fixture('timeout', 1_100);
    const result = await runVisibleG1({
      route: 'pi-json', driver: env.driver,
      boundary: { scope: 'visible-calibration', isolation: 'disabled', heldOut: false, evidenceRef: 'fixture-admission-timeout' },
      outputRoot: env.root, launchInventory: env.launchInventory, modelWallClockMs: 1_100,
      quotaSource: { async refresh() { return null; } },
    });
    const report = JSON.parse(readFileSync(result.reportPath, 'utf8')) as {
      workspaceConformance: { receipt: WorkspaceConformanceReceipt };
      rows: Array<{ outcome?: { score?: number }; taskOutcome?: { execution?: { terminalCause?: string } } }>;
      observations: Array<{ observation: NativeObservation }>;
      modelWallClockMs: number; budget: { wallClockMs: number; modelWallClockMs: number | null };
    };
    expect(report.workspaceConformance.receipt).toMatchObject({
      status: 'passed', workspaceSeparationStatus: 'passed', lifecycle: { qualification: 'qualified', processStatus: 'stopped', settlementStatus: 'settled' },
    });
    expect(report.observations[0]!.observation.terminal.cause).toBe('timeout');
    expect(report.observations[0]!.observation.model.settings.processTree?.value).toBe(true);
    expect(report.rows[0]?.taskOutcome?.execution?.terminalCause).toBe('budget-exhausted');
    expect(report.observations[0]!.observation.usage.counters.input.value).toBe(7);
    expect(report.observations[0]!.observation.usage.counters.cacheRead.value).toBeNull();
    expect(report.observations[0]!.observation.usage.counters.cacheWrite.value).toBeNull();
    expect(report.observations[0]!.observation.usage.tokenTotal.value).toBeNull();
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.modelWallClockMs).toBe(1_100);
    expect(report.budget).toMatchObject({ wallClockMs: 240_000, modelWallClockMs: 1_100, judgeWallClockMs: 60_000 });
  }, 30_000);
});
