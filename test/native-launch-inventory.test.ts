import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareLaunchProfiles,
  launchInventoryHash,
  readPaseoProfile,
  resolveLaunchExecutable,
} from '../runner/native/launch-inventory.ts';
import { resolveNativeLaunchInventory } from '../runner/native/inventory.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const profile = {
  label: 'test', executable: '/usr/bin/pi', version: 'Pi 1.0', args: ['--mode', 'json'],
  envKeys: ['OPENCODE_API_KEY'], cwdBehavior: 'workspace', providerRoute: 'pi-opencode',
  requestedModel: 'opencode-go/space-bunny-free', authClass: 'subscription route', effort: 'high',
  permissionPolicy: 'auto-accept', sandboxPolicy: null, systemContext: null, tools: null,
  extensions: null, assistance: ['auto_accept'], sessionBehavior: 'ephemeral', feedbackBehavior: null,
};

describe('launch inventory', () => {
  it('compares known changes separately from missing equivalence evidence', () => {
    const bridge = { ...profile, label: 'bridge', args: ['--mode', 'json', '--no-session'], cwdBehavior: null };
    const result = compareLaunchProfiles(profile, bridge);
    expect(result.status).toBe('unverified');
    expect(result.changed).toContain('args');
    expect(result.unknown).toContain('cwdBehavior');
  });

  it('loads only allowlisted profile fields and environment key names, never credential values', () => {
    const root = mkdtempSync(join(tmpdir(), 'cq-profile-test-'));
    roots.push(root);
    const secret = 'never-print-this-secret';
    const path = join(root, 'config.json');
    writeFileSync(path, JSON.stringify({
      daemon: { agentProfiles: [{ name: 'Space Bunny Free', provider: 'pi-opencode', model: 'opencode-go/space-bunny-free', thinkingOptionId: 'high', featureValues: { auto_accept: true } }] },
      agents: { providers: { 'pi-opencode': {
        extends: 'pi', env: { OPENCODE_API_KEY: secret }, command: ['pi', '--api-key', secret, `token=${secret}`],
        systemContext: ['private prompt text'], models: [{ id: 'opencode-go/space-bunny-free' }],
      } } },
    }));
    const inventory = readPaseoProfile(path, 'Space Bunny Free');
    expect(inventory.envKeys).toEqual(['OPENCODE_API_KEY']);
    expect(JSON.stringify(inventory)).not.toContain(secret);
    expect(JSON.stringify(inventory)).not.toContain('private prompt text');
    expect(inventory.args).toContain('<redacted>');
    expect(inventory.systemContext?.[0]).toMatch(/^sha256:/u);
    expect(inventory.requestedModel).toBe('opencode-go/space-bunny-free');
  });

  it('hashes stable profile identity and resolves the actual executable without shell interpolation', () => {
    expect(launchInventoryHash(profile)).toBe(launchInventoryHash({ ...profile }));
    expect(resolveLaunchExecutable(process.execPath)).toBe(process.execPath);
  });

  it('compares actual native commands with configured profiles and records only admitted environment names', () => {
    const root = mkdtempSync(join(tmpdir(), 'cq-native-inventory-'));
    roots.push(root);
    const configPath = join(root, 'config.json');
    const names = ['codex', 'pi-opencode', 'zcode'];
    writeFileSync(configPath, JSON.stringify({
      agentProfiles: names.map((provider) => ({
        name: `${provider} profile`, provider, model: provider === 'pi-opencode' ? 'opencode-go/space-bunny-free' : 'test-model',
        thinkingOptionId: 'high', featureValues: { auto_accept: true },
      })),
      agents: { providers: Object.fromEntries(names.map((provider) => [provider, {
        extends: provider, command: [process.execPath], env: { PROFILE_TOKEN: 'private-value' },
      }])) },
    }));
    const inventory = resolveNativeLaunchInventory(configPath, { environmentNames: { codex: ['PATH'], 'pi-opencode': ['OPENCODE_API_KEY'], zcode: ['ZAI_API_KEY'] } });
    expect(inventory.proposedBridges).toHaveLength(4);
    expect(inventory.proposedBridges.map((bridge) => bridge.envKeys)).toEqual([
      ['PATH'], ['OPENCODE_API_KEY'], ['OPENCODE_API_KEY'], ['ZAI_API_KEY'],
    ]);
    expect(inventory.proposedBridges[0]?.args).toContain('--ignore-user-config');
    expect(inventory.proposedBridges[1]?.args).toContain('--no-extensions');
    expect(inventory.comparisons.some(({ comparison }) => comparison.unknown.includes('tools'))).toBe(true);
    expect(JSON.stringify(inventory)).not.toContain('private-value');
  });
});
