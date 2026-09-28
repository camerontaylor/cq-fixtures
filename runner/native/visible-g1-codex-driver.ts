/** Trusted host adapter for the first visible-only Codex G1 route. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CodexExecDriver } from './codex.ts';
import { resolveNativeLaunchInventory } from './inventory.ts';
import { visibleCalibrationSpawnAdapter } from './process.ts';
import type { VisibleG1Route } from './run-visible-g1.ts';

const ENVIRONMENT_NAMES = ['CODEX_HOME', 'HOME', 'PATH', 'TMPDIR', 'XDG_CONFIG_HOME'];

export async function createVisibleG1Driver(input: { route: VisibleG1Route; outputRoot: string }) {
  if (input.route !== 'codex') throw new Error('this trusted host adapter currently supports only the configured Codex Sol route');
  const admissionId = process.env.CQ_VISIBLE_G1_ADMISSION_ID;
  if (!admissionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/u.test(admissionId)) {
    throw new Error('parent must provide a non-secret CQ_VISIBLE_G1_ADMISSION_ID before visible dispatch');
  }
  const configPath = process.env.CQ_PASEO_CONFIG ?? join(homedir(), '.paseo', 'config.json');
  const inventory = resolveNativeLaunchInventory(configPath, { environmentNames: { codex: ENVIRONMENT_NAMES } });
  const profile = inventory.configuredProfiles.find((candidate) => candidate.providerRoute.split(' ')[0] === 'codex'
    && candidate.requestedModel?.toLowerCase() === 'gpt-6-sol');
  if (!profile) throw new Error('configured Codex Sol gpt-6-sol profile was not found in the safe Paseo inventory');
  const driver = new CodexExecDriver({
    executable: profile.executable,
    version: profile.version,
    profile: profile.label,
    model: 'gpt-6-sol',
    effort: 'low',
    artifactDirectory: join(input.outputRoot, 'native-events'),
    hardWallClockMs: 120_000,
    spawnAdapter: visibleCalibrationSpawnAdapter({
      admissionId,
      scope: 'visible-calibration',
      isolation: 'disabled',
      heldOut: false,
      environmentNames: ENVIRONMENT_NAMES,
    }),
  });
  return {
    driver,
    boundary: {
      scope: 'visible-calibration' as const,
      isolation: 'disabled' as const,
      heldOut: false as const,
      evidenceRef: `parent-visible-admission:${admissionId}`,
    },
    launchInventory: inventory,
  };
}
