/** Trusted visible-only launcher for the configured ZCode GLM ACP route. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveNativeLaunchInventory } from './inventory.ts';
import { launchEvidenceStatus, type NativeLaunchEvidence } from './process.ts';
import { assertOutsideGlmBlackout, ZcodeAcpDriver, type ZcodeAcpOptions } from './zcode.ts';
import type { VisibleG1Route } from './run-visible-g1.ts';

const ENVIRONMENT_NAMES = ['HOME', 'PATH', 'TMPDIR', 'XDG_CONFIG_HOME'];
const PROFILE_LABEL = 'GLM-5.3-Flash';

/** Driver-module entrypoint consumed by runner/native/run-visible-g1.ts. */
export async function createVisibleG1Driver(input: { route: VisibleG1Route; outputRoot: string }) {
  if (input.route !== 'glm') throw new Error('this trusted host adapter supports only the ZCode GLM route');
  assertOutsideGlmBlackout();
  const admissionId = process.env.CQ_VISIBLE_G1_ADMISSION_ID;
  if (!admissionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/u.test(admissionId)) {
    throw new Error('parent must provide a non-secret CQ_VISIBLE_G1_ADMISSION_ID before visible dispatch');
  }
  const configPath = process.env.CQ_PASEO_CONFIG ?? join(homedir(), '.paseo', 'config.json');
  const inventory = resolveNativeLaunchInventory(configPath, {
    environmentNames: { zcode: ENVIRONMENT_NAMES },
  });
  const profile = inventory.configuredProfiles.find((candidate) => candidate.label === PROFILE_LABEL &&
    candidate.providerRoute.split(' ')[0] === 'zcode' &&
    candidate.requestedModel?.toLowerCase() === 'glm-5.3-flash');
  if (!profile || profile.effort !== 'high' || profile.permissionPolicy !== 'yolo') {
    throw new Error('configured ZCode GLM-5.3-Flash high/yolo profile was not found in the safe Paseo inventory');
  }

  const executable = 'zcode-acp';
  const launchEvidence: NativeLaunchEvidence = {
    boundaryIdentity: 'visible-only-unconfined',
    launchIdentity: createHash('sha256').update(JSON.stringify({ executable, args: ['server'], admissionId })).digest('hex'),
    admissionId,
    environmentNames: ENVIRONMENT_NAMES.filter((name) => process.env[name] !== undefined),
    scope: 'visible-calibration',
    isolation: 'disabled',
    heldOut: false,
  };
  const spawnAcp: NonNullable<ZcodeAcpOptions['spawn']> = ({ command, args, cwd, env }) => {
    if (command !== executable || args.length !== 1 || args[0] !== 'server') {
      throw new Error('ZCode ACP attempted an unconfigured command or argument vector');
    }
    const allowedEnv = Object.fromEntries(ENVIRONMENT_NAMES.flatMap((name) => {
      const value = env[name] ?? process.env[name];
      return value === undefined ? [] : [[name, value]];
    }));
    return spawn(command, [...args], {
      cwd, env: allowedEnv, stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', windowsHide: true,
    });
  };
  const driver = new ZcodeAcpDriver({
    executable,
    profile: profile.label,
    version: null,
    artifactDirectory: join(input.outputRoot, 'native-events'),
    hardWallClockMs: 120_000,
    spawn: spawnAcp,
    launchEvidence,
  });
  if (launchEvidenceStatus(launchEvidence) !== 'visible-only-unconfined') {
    throw new Error('ZCode launch evidence did not resolve to visible-only calibration');
  }
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
