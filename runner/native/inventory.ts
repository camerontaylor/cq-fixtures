import { homedir } from 'node:os';
import { join } from 'node:path';
import { compareLaunchProfiles, readConfiguredPaseoProfiles, type LaunchComparison, type LaunchProfile } from './launch-inventory.ts';

export interface NativeLaunchInventory {
  generatedAt: string;
  configuredProfiles: LaunchProfile[];
  proposedBridges: LaunchProfile[];
  comparisons: Array<{ target: string; comparison: LaunchComparison }>;
}

/** Build a credential-safe comparison from local Paseo declarations and bridge argv. */
export function resolveNativeLaunchInventory(
  configPath = join(homedir(), '.paseo', 'config.json'),
): NativeLaunchInventory {
  const configuredProfiles = readConfiguredPaseoProfiles(configPath);
  const proposedBridges: LaunchProfile[] = [
    {
      label: 'Codex native exec bridge', executable: 'codex', version: null,
      args: ['exec', '--json', '--ephemeral', '--sandbox', '<invocation-policy>', '-C', '<assigned-workspace>', '-m', '<requested-model>', '-c', 'model_reasoning_effort=<requested-effort>', '-'],
      envKeys: [...new Set(Object.keys(process.env))].sort(), cwdBehavior: 'assigned workspace (provided by runner integration)',
      providerRoute: 'Codex subscription profile', requestedModel: 'gpt-6-luna', authClass: 'host Codex CLI authentication; exact account class unverified',
      effort: 'requested via model_reasoning_effort', permissionPolicy: 'native CLI sandbox flag',
      sandboxPolicy: 'per-invocation; native CLI sandbox', systemContext: null, tools: null, extensions: null,
      assistance: null, sessionBehavior: 'ephemeral', feedbackBehavior: null,
    },
    {
      label: 'Pi OpenCode Go bridge', executable: 'pi', version: null,
      args: ['--mode', '<json|rpc>', '--provider', 'opencode-go', '--model', 'opencode-go/space-bunny-free:high', '--no-session', '-p', '<prompt>'],
      envKeys: [...new Set(Object.keys(process.env))].sort(), cwdBehavior: 'process working directory; runner binding pending',
      providerRoute: 'pi-opencode → opencode-go', requestedModel: 'opencode-go/space-bunny-free', authClass: 'configured OpenCode Go subscription route',
      effort: 'high requested via Pi CLI', permissionPolicy: 'Pi configured auto-accept/profile behavior',
      sandboxPolicy: null, systemContext: null, tools: null, extensions: null, assistance: null,
      sessionBehavior: 'no-session', feedbackBehavior: null,
    },
    {
      label: 'ZCode ACP bridge', executable: 'zcode-acp', version: null,
      args: ['server'], envKeys: [...new Set(Object.keys(process.env))].sort(),
      cwdBehavior: 'SessionStore bound to runner-provided workspace', providerRoute: 'zcode → native ZAI Coding Plan',
      requestedModel: 'GLM-5.3-Flash', authClass: 'ZCode native authenticated provider', effort: 'high requested; ACP effective status pending',
      permissionPolicy: 'profile mode yolo; ACP mode pin/conformance pending', sandboxPolicy: 'workspace-root session; command policy pending',
      systemContext: null, tools: null, extensions: null, assistance: null, sessionBehavior: 'fresh native ACP session per attempt',
      feedbackBehavior: null,
    },
  ];
  const expectedProvider = new Map([
    ['Codex native exec bridge', 'codex'],
    ['Pi OpenCode Go bridge', 'pi-opencode'],
    ['ZCode ACP bridge', 'zcode'],
  ]);
  return {
    generatedAt: new Date().toISOString(), configuredProfiles, proposedBridges,
    comparisons: proposedBridges.map((bridge) => {
      const configured = configuredProfiles.find((entry) => expectedProvider.get(bridge.label) === entry.providerRoute.split(' ')[0]);
      if (!configured) return { target: bridge.label, comparison: compareLaunchProfiles(unknownProfile(bridge.label), bridge) };
      return { target: bridge.label, comparison: compareLaunchProfiles(configured, bridge) };
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
