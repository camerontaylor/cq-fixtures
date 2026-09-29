import { assignmentResourceOwner } from './assignment-supervisor-owner.ts';
import { g2DaemonEndpoint } from './g2-daemon-contract.ts';
import { spawn } from 'node:child_process';
import { mkdtempSync, chmodSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** Private empty client config; fixed daemon, no contexts/proxies/helpers/headers. */
export class DockerControl {
  readonly configDirectory = mkdtempSync(join(tmpdir(), 'cq-s5-docker-config-'));
  readonly environment = { HOME: homedir(), PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
  readonly prefix: string[];
  constructor(private readonly preregister: (resource: { kind: 'container'; id: string }) => Promise<void> = assignmentResourceOwner()) {
    chmodSync(this.configDirectory, 0o700); writeFileSync(join(this.configDirectory, 'config.json'), '{}\n', { mode: 0o600 });
    this.prefix = ['--config', this.configDirectory, '--host', g2DaemonEndpoint()];
  }
  async run(args: string[], input?: string, maxBytes = 256 * 1024, timeoutMs = 30_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/local/bin/docker', [...this.prefix, ...args], { env: this.environment, stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = []; const err: Buffer[] = []; let bytes = 0; let failed = false; let failureClass = 'DockerOperationFailed';
      const timer = setTimeout(() => { failed = true; failureClass = 'DeadlineExceeded'; child.kill('SIGKILL'); }, Math.max(1, Math.min(30_000, timeoutMs)));
      child.stdout.on('data', (b: Buffer) => { bytes += b.length; if (bytes > maxBytes) { failed = true; failureClass = 'OutputLimitExceeded'; child.kill('SIGKILL'); } else out.push(b); });
      child.stderr.on('data', (b: Buffer) => { if (err.reduce((n, c) => n + c.length, 0) < 8192) err.push(b); });
      child.once('error', (e) => { clearTimeout(timer); reject(e); });
      child.once('close', (code) => { clearTimeout(timer); if (failed || code !== 0) reject(Object.assign(new Error(`bounded Docker operation failed (${args[0]}, ${code})`), { name: failureClass })); else resolve(Buffer.concat(out).toString().trim()); });
      child.stdin.on('error', () => {}); child.stdin.end(input);
    });
  }
  async utility(args: string[], input?: string, maxBytes?: number): Promise<string> {
    const name = 'cq-s5-utility-' + (await import('node:crypto')).randomBytes(8).toString('hex');
    await this.preregister({ kind: 'container', id: name });
    let primary: unknown;
    try { return await this.run(['run', '--name', name, ...args], input, maxBytes); }
    catch (error) { primary = error; throw error; }
    finally {
      try {
        const ids = await this.run(['ps', '-aq', '--no-trunc', '--filter', `name=^/${name}$`]);
        if (ids) await teardownContainer(this, ids);
      } catch (error) { if (!primary) throw error; }
    }
  }
  close(): void { rmSync(this.configDirectory, { recursive: true, force: true }); }
}

/** Kill container init and every namespace child, then require absence read-back. */
export async function teardownContainer(control: DockerControl, id: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('exact private container ID required');
  const present = await control.run(['ps', '-aq', '--no-trunc', '--filter', `id=${id}`]);
  if (present) await control.run(['rm', '-f', id]);
  if (await control.run(['ps', '-aq', '--no-trunc', '--filter', `id=${id}`])) throw new Error('container teardown unverified');
}
