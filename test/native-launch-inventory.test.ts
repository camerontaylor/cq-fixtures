import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compareLaunchProfiles,
  launchInventoryHash,
  readPaseoProfile,
  resolveLaunchExecutable,
} from '../runner/native/launch-inventory.ts';
import { resolveNativeLaunchInventory } from '../runner/native/inventory.ts';

const roots: string[] = [];
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'cq-inventory-version-'));
  roots.push(root);
  for (const command of ['codex', 'pi', 'zcode-acp']) {
    writeFileSync(join(root, command), '#!/bin/sh\necho fixture-version-1\n', { mode: 0o700 });
  }
  vi.stubEnv('PATH', `${root}:${process.env.PATH ?? ''}`);
});
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const profile = {
  label: 'test', executable: '/usr/bin/pi', version: 'Pi 1.0', args: ['--mode', 'json'],
  envKeys: ['OPENCODE_API_KEY'], cwdBehavior: 'workspace', providerRoute: 'pi-opencode',
  requestedModel: 'opencode-go/space-bunny-free', authClass: 'subscription route', effort: 'high',
  permissionPolicy: 'auto-accept', sandboxPolicy: null, systemContext: null, tools: null,
  extensions: null, assistance: ['auto_accept'], sessionBehavior: 'ephemeral', feedbackBehavior: null,
};

describe('launch inventory', () => {
  it('keeps exact Luna and Sol profiles separate regardless of inventory order', () => {
    const root = mkdtempSync(join(tmpdir(), 'cq-model-inventory-'));
    roots.push(root);
    const path = join(root, 'config.json');
    for (const models of [['gpt-6-sol', 'gpt-6-luna'], ['gpt-6-luna', 'gpt-6-sol']]) {
      writeFileSync(path, JSON.stringify({
        agentProfiles: models.map((model) => ({ name: model, provider: 'codex', model,
          thinkingOptionId: model.endsWith('luna') ? 'high' : 'low', modeId: 'full-access' })),
        agents: { providers: { codex: { command: [process.execPath] } } },
      }));
      const inventory = resolveNativeLaunchInventory(path);
      for (const model of models) {
        const comparison = inventory.comparisons.find((item) => item.comparison.bridge.requestedModel === model)!;
        expect(comparison.comparison.configured.requestedModel).toBe(model);
        expect(comparison.comparison.bridge.args).toContain(model);
        expect(comparison.comparison.status).toBe('unverified');
      }
    }
  }, 15_000);

  it('binds allowed assistance values without exposing unknown feature payloads', () => {
    const root = mkdtempSync(join(tmpdir(), 'cq-assistance-inventory-'));
    roots.push(root);
    const path = join(root, 'config.json');
    const hashes = [false, true].map((auto_accept) => {
      writeFileSync(path, JSON.stringify({
        agentProfiles: [{ name: 'Bunny', provider: 'pi-opencode', featureValues: { auto_accept, custom: 'private-value' } }],
        agents: { providers: { 'pi-opencode': { command: [process.execPath] } } },
      }));
      const profile = readPaseoProfile(path, 'Bunny');
      expect(profile.assistance).toContain(`auto_accept=${auto_accept}`);
      expect(profile.assistance).toContain('custom:unknown');
      expect(JSON.stringify(profile)).not.toContain('private-value');
      return launchInventoryHash(profile);
    });
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it('materializes a requested Luna fallback without inheriting Sol assistance or effort', () => {
    const root = mkdtempSync(join(tmpdir(), 'cq-luna-fallback-'));
    roots.push(root);
    const path = join(root, 'config.json');
    writeFileSync(path, JSON.stringify({
      agentProfiles: [{ name: 'Sol', provider: 'codex', model: 'gpt-6-sol', thinkingOptionId: 'low', featureValues: { fast_mode: true } }],
      agents: { providers: { codex: { command: [process.execPath] } } },
    }));
    const inventory = resolveNativeLaunchInventory(path);
    const luna = inventory.configuredProfiles.find((profile) => profile.requestedModel === 'gpt-6-luna')!;
    expect(luna.label).toContain('fallback (unverified)');
    expect(luna.effort).toBe('high');
    expect(luna.assistance).toBeNull();
    expect(luna.permissionPolicy).toBe('full-access');
  }, 15_000);

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
    expect(inventory.proposedBridges).toHaveLength(5);
    expect(inventory.proposedBridges.map((bridge) => bridge.envKeys)).toEqual([
      ['PATH'], ['PATH'], ['OPENCODE_API_KEY'], ['OPENCODE_API_KEY'], ['ZAI_API_KEY'],
    ]);
    expect(inventory.proposedBridges[0]?.args).toContain('--ignore-user-config');
    expect(inventory.proposedBridges[2]?.args).toContain('--no-approve');
    expect(inventory.proposedBridges[2]?.args).not.toContain('--no-extensions');
    expect(inventory.proposedBridges[2]?.extensions).toBeNull();
    expect(inventory.comparisons.some(({ comparison }) => comparison.unknown.includes('tools'))).toBe(true);
    expect(JSON.stringify(inventory)).not.toContain('private-value');
  }, 15_000);
});
