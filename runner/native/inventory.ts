import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  compareLaunchProfiles, readConfiguredPaseoProfiles, readExecutableVersion, resolveLaunchExecutable,
  type LaunchComparison, type LaunchProfile,
} from './launch-inventory.ts';

export type NativeRouteName = 'codex' | 'pi-opencode' | 'zcode';

export interface NativeLaunchInventoryOptions {
  /** Exact environment key names accepted by the visible or boundary admission. */
  environmentNames?: Partial<Record<NativeRouteName, string[]>>;
}

export interface NativeLaunchInventory {
  generatedAt: string;
  configuredProfiles: LaunchProfile[];
  proposedBridges: LaunchProfile[];
  comparisons: Array<{ target: string; comparison: LaunchComparison }>;
}

/** Compare selected Paseo profiles with the actual bridge commands and arguments. */
export function resolveNativeLaunchInventory(
  configPath = join(homedir(), '.paseo', 'config.json'),
  options: NativeLaunchInventoryOptions = {},
): NativeLaunchInventory {
  const configuredProfiles = readConfiguredPaseoProfiles(configPath);
  const byProvider = (provider: NativeRouteName) => configuredProfiles.find((profile) => profile.providerRoute.split(' ')[0] === provider);
  const environmentNames = (route: NativeRouteName) => [...new Set(options.environmentNames?.[route] ?? [])].sort();
  const executable = (name: string) => resolveLaunchExecutable(name);
  const profile = (
    route: NativeRouteName,
    label: string,
    command: string,
    args: string[],
    cwdBehavior: string,
    requestedModel: string,
    effort: string | null,
    permissionPolicy: string | null,
    sandboxPolicy: string | null,
    sessionBehavior: string,
    extensions: string[] | null,
  ): LaunchProfile => {
    const selected = byProvider(route);
    return {
      label,
      executable: executable(command),
      version: readExecutableVersion(executable(command)),
      args,
      envKeys: environmentNames(route),
      cwdBehavior,
      providerRoute: selected?.providerRoute ?? 'unknown',
      requestedModel,
      authClass: selected?.authClass ?? 'unknown',
      effort,
      permissionPolicy,
      sandboxPolicy,
      systemContext: null,
      tools: null,
      extensions,
      assistance: null,
      sessionBehavior,
      feedbackBehavior: null,
    };
  };

  const proposedBridges: LaunchProfile[] = [
    profile('codex', 'Codex native exec bridge', 'codex', [
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', '<invocation sandbox>',
      '-C', '<SessionStore workspace>', '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort="low"', '-',
    ], 'runner SessionStore workspace; Codex turn ephemeral', 'gpt-6-sol', 'low requested; CLI does not report effective effort',
    'OpInvocation tool policy requested; codex exec flags do not enforce it', 'per-invocation --sandbox', 'ephemeral', []),
    ...(['json', 'rpc'] as const).map((mode) => profile('pi-opencode', `Pi ${mode.toUpperCase()} bridge`, 'pi', [
      '--mode', mode, '--provider', 'opencode-go', '--model', 'opencode-go/space-bunny-free:high',
      '--thinking', 'high', '--no-session', '--no-extensions', '<policy-derived tool flags>', '-p', '<prompt>',
    ], 'runner SessionStore workspace; Pi session ephemeral', 'opencode-go/space-bunny-free', 'high',
    'policy-derived --tools/--no-tools', 'unsupported by Pi CLI; native profile governs shell access', 'no-session', [])),
    profile('zcode', 'ZCode ACP bridge', 'zcode-acp', ['server'],
      'runner SessionStore workspace via ACP session cwd', 'GLM-5.3-Flash', 'high requested; ACP effective status unverified',
      'Paseo profile mode yolo; effective ACP permissions unverified', 'ACP server profile; effective sandbox unverified',
      'fresh ACP session per attempt', null),
  ];

  return {
    generatedAt: new Date().toISOString(), configuredProfiles, proposedBridges,
    comparisons: proposedBridges.map((bridge) => {
      const route = bridge.label.startsWith('Codex') ? 'codex' : bridge.label.startsWith('Pi') ? 'pi-opencode' : 'zcode';
      const configured = byProvider(route);
      return { target: bridge.label, comparison: compareLaunchProfiles(configured ?? unknownProfile(bridge.label), bridge) };
    }),
  };
}

function unknownProfile(label: string): LaunchProfile {
  return {
    label, executable: 'unknown', version: null, args: [], envKeys: [], cwdBehavior: 'unknown',
    providerRoute: 'unknown', requestedModel: null, authClass: 'unknown', effort: null,
    permissionPolicy: null, sandboxPolicy: null, systemContext: null, tools: null,
    extensions: null, assistance: null, sessionBehavior: null, feedbackBehavior: null,
  };
}
