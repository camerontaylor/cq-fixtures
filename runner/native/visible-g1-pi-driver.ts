/** Trusted visible-only launcher for the configured Pi/OpenCode Go route. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PiNativeDriver, type PiMode } from './pi.ts';
import { resolveNativeLaunchInventory } from './inventory.ts';
import { visibleCalibrationSpawnAdapter } from './process.ts';
import type { VisibleG1Route } from './run-visible-g1.ts';

const ENVIRONMENT_NAMES = ['HOME', 'OPENCODE_API_KEY', 'PATH', 'TMPDIR', 'XDG_CONFIG_HOME'];
const PROFILE_LABEL = 'Space Bunny Free (Pi OpenCode)';
const MODEL = 'opencode-go/space-bunny-free';

/**
 * Validate that the native process will receive precisely the credential value
 * already configured for this Paseo provider. Values stay in memory and are
 * never included in diagnostics, observations, or artifacts.
 */
export function assertPiConfiguredAuthHandoff(configPath: string): string {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as PaseoConfig;
  const profile = (config.agentProfiles ?? config.daemon?.agentProfiles ?? []).find((item) => item.name === PROFILE_LABEL);
  if (!profile || profile.provider !== 'pi-opencode' || profile.model !== MODEL) {
    throw new Error('configured Pi/OpenCode Go profile does not match the approved anonymous route');
  }
  const provider = config.agents?.providers?.[profile.provider];
  if (provider?.extends !== 'pi') throw new Error('configured Pi provider no longer extends the installed Pi runtime');
  const configuredValue = provider.env?.OPENCODE_API_KEY;
  if (typeof configuredValue !== 'string' || !configuredValue) {
    throw new Error('Pi OpenCode Go auth handoff is unavailable in the configured Paseo provider');
  }
  return configuredValue;
}

/** Driver-module entrypoint consumed by runner/native/run-visible-g1.ts. */
export async function createVisibleG1Driver(input: { route: VisibleG1Route; outputRoot: string }) {
  if (input.route !== 'pi-json' && input.route !== 'pi-rpc') {
    throw new Error('this trusted host adapter supports only pi-json and pi-rpc');
  }
  const admissionId = process.env.CQ_VISIBLE_G1_ADMISSION_ID;
  if (!admissionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/u.test(admissionId)) {
    throw new Error('parent must provide a non-secret CQ_VISIBLE_G1_ADMISSION_ID before visible dispatch');
  }
  const configPath = process.env.CQ_PASEO_CONFIG ?? join(homedir(), '.paseo', 'config.json');
  const configuredAuth = assertPiConfiguredAuthHandoff(configPath);
  const mode: PiMode = input.route === 'pi-json' ? 'json' : 'rpc';
  const inventory = resolveNativeLaunchInventory(configPath, {
    environmentNames: { 'pi-opencode': ENVIRONMENT_NAMES },
  });
  const profile = inventory.configuredProfiles.find((candidate) => candidate.label === PROFILE_LABEL &&
    candidate.providerRoute.split(' ')[0] === 'pi-opencode' && candidate.requestedModel === MODEL);
  if (!profile || profile.effort !== 'high') {
    throw new Error('configured Pi OpenCode Go high-effort profile was not found in the safe Paseo inventory');
  }
  const driver = new PiNativeDriver({
    mode,
    executable: profile.executable,
    version: profile.version,
    profile: profile.label,
    provider: 'opencode-go',
    model: MODEL,
    thinking: 'high',
    artifactDirectory: join(input.outputRoot, 'native-events'),
    hardWallClockMs: 120_000,
    spawnAdapter: visibleCalibrationSpawnAdapter({
      admissionId, scope: 'visible-calibration', isolation: 'disabled', heldOut: false,
      environmentNames: ENVIRONMENT_NAMES,
    }, { environmentValues: { OPENCODE_API_KEY: configuredAuth } }),
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

interface PaseoProvider { extends?: string; env?: Record<string, string> }
interface PaseoProfile { name: string; provider: string; model?: string }
interface PaseoConfig {
  agentProfiles?: PaseoProfile[];
  daemon?: { agentProfiles?: PaseoProfile[] };
  agents?: { providers?: Record<string, PaseoProvider> };
}
