import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { delimiter, join, resolve } from 'node:path';

export type ProfileStatus = 'equivalent' | 'intentionally-altered' | 'unverified';

export interface LaunchProfile {
  label: string;
  executable: string;
  version: string | null;
  args: string[];
  envKeys: string[];
  cwdBehavior: string | null;
  providerRoute: string;
  requestedModel: string | null;
  authClass: string;
  effort: string | null;
  permissionPolicy: string | null;
  sandboxPolicy: string | null;
  systemContext: string[] | null;
  tools: string[] | null;
  extensions: string[] | null;
  assistance: string[] | null;
  sessionBehavior: string | null;
  feedbackBehavior: string | null;
}

export interface LaunchComparison {
  status: ProfileStatus;
  changed: string[];
  unknown: string[];
  configured: LaunchProfile;
  bridge: LaunchProfile;
}

const PROFILE_FIELDS: Array<keyof LaunchProfile> = [
  'executable', 'version', 'args', 'envKeys', 'cwdBehavior', 'providerRoute',
  'requestedModel', 'authClass', 'effort', 'permissionPolicy', 'sandboxPolicy',
  'systemContext', 'tools', 'extensions', 'assistance', 'sessionBehavior', 'feedbackBehavior',
];

/** Compare effective launch facts. Null means the corresponding fact is unknown. */
export function compareLaunchProfiles(configured: LaunchProfile, bridge: LaunchProfile): LaunchComparison {
  const changed: string[] = [];
  const unknown: string[] = [];
  for (const field of PROFILE_FIELDS) {
    const left = configured[field];
    const right = bridge[field];
    if (left === null || right === null) unknown.push(field);
    else if (canonical(left) !== canonical(right)) changed.push(field);
  }
  const status: ProfileStatus = unknown.length > 0
    ? 'unverified'
    : changed.length > 0 ? 'intentionally-altered' : 'equivalent';
  return { status, changed, unknown, configured, bridge };
}

/** A privacy-safe snapshot of the selected Paseo provider/profile, never auth values. */
export function readPaseoProfile(
  configPath: string,
  profileName: string,
  executableOverride?: string,
): LaunchProfile {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as PaseoConfig;
  const selected = (config.agentProfiles ?? config.daemon?.agentProfiles)?.find((profile) => profile.name === profileName);
  if (!selected) throw new Error(`Paseo profile not found: ${profileName}`);
  const provider = config.agents?.providers?.[selected.provider];
  if (!provider) throw new Error(`Paseo provider not found for profile: ${profileName}`);
  const command = provider.command ?? [];
  const executable = executableOverride ?? command[0] ?? provider.executable ?? provider.extends ?? selected.provider;
  const executablePath = resolveLaunchExecutable(executable);
  const model = selected.model ?? null;
  const configuredArgs = command.length > 0 ? command.slice(1) : provider.args ?? [];
  const args = redactArgs(configuredArgs, Object.values(provider.env ?? {}));
  return {
    label: selected.name,
    executable: executablePath,
    version: readExecutableVersion(executablePath),
    args,
    envKeys: [...Object.keys(provider.env ?? {})].sort(),
    cwdBehavior: provider.cwdBehavior ?? 'unknown',
    providerRoute: `${selected.provider}${provider.extends ? ` extends ${provider.extends}` : ''}`,
    requestedModel: model,
    authClass: safeAuthClass(selected.provider),
    effort: selected.thinkingOptionId ?? null,
    permissionPolicy: selected.modeId ?? provider.permissionPolicy ?? null,
    sandboxPolicy: provider.sandboxPolicy ?? null,
    systemContext: provider.systemContext?.map((item) => `sha256:${createHash('sha256').update(item).digest('hex')}`) ?? null,
    tools: provider.tools ?? null,
    extensions: provider.extensions ?? null,
    assistance: selected.featureValues ? Object.keys(selected.featureValues).sort() : provider.assistance ?? null,
    sessionBehavior: provider.sessionBehavior ?? null,
    feedbackBehavior: provider.feedbackBehavior ?? null,
  };
}

/** Hash a safe inventory for artifact manifests without serializing credentials. */
export function launchInventoryHash(profile: LaunchProfile): string {
  return createHash('sha256').update(canonical(profile)).digest('hex');
}

export function resolveLaunchExecutable(executable: string): string {
  const candidates = executable.includes('/') || executable.includes('\\')
    ? [resolve(executable)]
    : (process.env.PATH ?? '').split(delimiter).map((directory) => join(directory, executable));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } catch { /* try next PATH entry */ }
  }
  return executable;
}

export function readExecutableVersion(executable: string): string | null {
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8', timeout: 3000, env: { ...process.env, NO_COLOR: '1', CI: '1' },
  });
  if (result.error || result.status !== 0) return null;
  const version = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split(/\r?\n/u)[0];
  return version ? version.slice(0, 160) : null;
}

export function readConfiguredPaseoProfiles(configPath: string): LaunchProfile[] {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as PaseoConfig;
  const profiles = config.agentProfiles ?? config.daemon?.agentProfiles ?? [];
  return profiles
    .filter((profile) => {
      const id = profile.model?.toLowerCase() ?? '';
      return profile.provider === 'codex' ||
        (profile.provider === 'pi-opencode' && id.includes('space-bunny-free')) ||
        (profile.provider === 'zcode' && /glm-5\.3-flash/i.test(profile.model ?? ''));
    })
    .map((profile) => readPaseoProfile(configPath, profile.name));
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

function redactArgs(args: string[], secretValues: string[]): string[] {
  const safe: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      safe.push('<redacted>');
      redactNext = false;
      continue;
    }
    if (/^(?:--?)?(?:api[-_]?key|token|secret|password|authorization|credential)$/iu.test(arg)) {
      safe.push(arg);
      redactNext = true;
      continue;
    }
    let value = arg.replace(/((?:api[-_]?key|token|secret|password|authorization|credential)[=:])[^\s]+/giu, '$1<redacted>');
    for (const secret of secretValues) if (secret.length > 3) value = value.replaceAll(secret, '<redacted>');
    if (value !== arg) safe.push(value);
    else if (/^--?[A-Za-z0-9][A-Za-z0-9-]*$/u.test(arg)) safe.push(arg);
    else safe.push(`sha256:${createHash('sha256').update(arg).digest('hex')}`);
  }
  if (redactNext) safe.push('<redacted>');
  return safe;
}

function safeAuthClass(provider: string): string {
  if (provider === 'codex') return 'host Codex CLI authentication; account class unverified';
  if (provider === 'zcode') return 'ZCode native authenticated provider; account class unverified';
  if (provider === 'pi-opencode') return 'configured OpenCode Go route; account class unverified';
  return 'configured provider; authentication class unverified';
}

interface PaseoModel { id: string; thinkingOptions?: Array<{ id: string }> }
interface PaseoProfile { name: string; provider: string; model?: string; thinkingOptionId?: string; modeId?: string; featureValues?: Record<string, unknown> }
interface PaseoProvider {
  extends?: string; command?: string[]; executable?: string; args?: string[]; env?: Record<string, string>;
  models?: PaseoModel[]; cwdBehavior?: string; authClass?: string; permissionPolicy?: string;
  sandboxPolicy?: string; systemContext?: string[]; tools?: string[]; extensions?: string[];
  assistance?: string[]; sessionBehavior?: string; feedbackBehavior?: string;
}
interface PaseoConfig {
  agentProfiles?: PaseoProfile[];
  daemon?: { agentProfiles?: PaseoProfile[] };
  agents?: { providers?: Record<string, PaseoProvider> };
}
