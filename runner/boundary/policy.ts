import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative } from 'node:path';

export interface ReadGrant {
  path: string;
  kind: 'file' | 'tree';
  reason: string;
}
export interface BoundarySpec {
  /** Fresh dedicated parent containing task/, context/, home/, tmp/. */
  bundle: string;
  task: string;
  context: string;
  home: string;
  temporary: string;
  toolchain: ReadGrant[];
  /** Exact files only; stage subscription auth in context when possible. */
  authentication: Array<{ path: string; reason: string }>;
  executables: string[];
  /** Judge, solutions, sibling tasks, research, event archives, ambient config. */
  forbidden: string[];
  endpoints: Array<{ address: string; port: number; reason: string }>;
  /** Verified loopback broker upstream ACL/service inventory artifact; required for route network. */
  networkEvidence?: string;
  /** No automatic MCP/plugins/extensions. Native owner verifies disabling flags. */
  extensions: { mode: 'disabled'; launchEvidence: string | null };
}
export interface BoundaryPolicy {
  version: 1;
  backend: 'macos-sandbox-exec';
  identity: string;
  profile: string;
  resolved: BoundarySpec;
  environment: Record<string, string>;
  /** Filesystem protection is testable independently of native profile controls. */
  nativeControlsAttested: boolean;
  /** This host policy does not isolate same-user process argv/environment. */
  heldOutEligible: false;
}

function inside(path: string, parent: string): boolean {
  const r = relative(parent, path);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}
function canonical(path: string): string {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('boundary requires absolute clean paths');
  return realpathSync(path);
}
function quote(value: string): string {
  return JSON.stringify(value);
}
const SYSTEM_TREES = ['/System/Library', '/usr/lib', '/private/var/db/dyld'];
// Darwin dyld requires opening the root directory; literal / is not a recursive grant.
const SYSTEM_FILES = ['/', '/dev/null', '/dev/random', '/dev/urandom', '/private/var/select/sh'];

/** Compile a positive read allowlist. No ambient environment or implicit home grants. */
export function compileBoundary(spec: BoundarySpec): BoundaryPolicy {
  const bundle = canonical(spec.bundle);
  const ambientHome = canonical(homedir());
  const broad = ['/', '/Users', '/Volumes', '/private', '/private/tmp', '/tmp', '/usr', '/usr/local', '/opt', ambientHome];
  if (broad.includes(bundle) || inside(ambientHome, bundle)) throw new Error('bundle is a blanket root');
  const directories = [spec.task, spec.context, spec.home, spec.temporary].map(canonical);
  for (const path of directories) {
    if (!inside(path, bundle) || path === bundle || !statSync(path).isDirectory()) {
      throw new Error('task/context/home/tmp must be dedicated bundle directories');
    }
  }
  for (let a = 0; a < directories.length; a++) {
    for (let b = a + 1; b < directories.length; b++) {
      if (inside(directories[a], directories[b]) || inside(directories[b], directories[a])) {
        throw new Error('bundle directories must be disjoint');
      }
    }
  }
  const forbidden = spec.forbidden.map(canonical).sort();
  if (forbidden.length === 0) throw new Error('declare hidden and ambient paths');
  const toolchain = spec.toolchain.map((grant) => {
    const path = canonical(grant.path);
    if (!grant.reason.trim() || broad.includes(path) || inside(ambientHome, path)) {
      throw new Error('blanket or unjustified toolchain grant');
    }
    if (statSync(path).isDirectory() !== (grant.kind === 'tree')) throw new Error('grant kind mismatch');
    return { ...grant, path };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const authentication = spec.authentication.map((grant) => {
    const path = canonical(grant.path);
    if (!grant.reason.trim() || !statSync(path).isFile()) throw new Error('auth grants must be justified exact files');
    return { ...grant, path };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const executables = [...new Set(spec.executables.map(canonical))].sort();
  if (executables.length === 0 || executables.some((path) => !statSync(path).isFile())) {
    throw new Error('declare executable files');
  }
  const endpoints = spec.endpoints.map((endpoint) => ({ ...endpoint, address: endpoint.address === '127.0.0.1' ? 'localhost' : endpoint.address })).sort((a, b) => a.address.localeCompare(b.address) || a.port - b.port);
  for (const endpoint of endpoints) {
    if (endpoint.address !== 'localhost' || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !endpoint.reason.trim()) {
      throw new Error('endpoints require localhost/port and reason; direct external hosts, DNS/wildcards need a verified broker or VM');
    }
  }
  if (spec.extensions.mode !== 'disabled') throw new Error('undeclared extensions are unsupported');
  const grants: ReadGrant[] = [
    ...directories.map((path): ReadGrant => ({ path, kind: 'tree', reason: 'dedicated execution bundle' })),
    ...toolchain,
    ...authentication.map((grant): ReadGrant => ({ ...grant, kind: 'file' })),
    ...executables.map((path): ReadGrant => ({ path, kind: 'file', reason: 'declared executable' })),
    ...SYSTEM_TREES.map((path): ReadGrant => ({ path, kind: 'tree', reason: 'macOS runtime' })),
    ...SYSTEM_FILES.map((path): ReadGrant => ({ path, kind: 'file', reason: 'runtime device' })),
  ];
  for (const grant of grants) {
    if (forbidden.some((path) => inside(grant.path, path) || (grant.kind === 'tree' && inside(path, grant.path)))) {
      throw new Error('read allowlist overlaps forbidden material');
    }
  }
  const filter = (grant: ReadGrant) => `(${grant.kind === 'tree' ? 'subpath' : 'literal'} ${quote(grant.path)})`;
  // Metadata on parent directories permits getcwd/realpath, never directory enumeration/content.
  const parents = new Set<string>();
  for (const grant of grants) {
    let parent = dirname(grant.path);
    while (parent !== '/') { parents.add(parent); parent = dirname(parent); }
  }
  const profile = [
    '(version 1)', '(deny default)',
    '(allow process-fork)',
    `(allow process-exec ${executables.map((path) => `(literal ${quote(path)})`).join(' ')})`,
    '(allow sysctl-read)',
    `(allow file-read* ${grants.map(filter).join(' ')})`,
    `(allow file-read-metadata ${[...parents].sort().map((path) => `(literal ${quote(path)})`).join(' ')})`,
    `(allow file-write* ${[directories[0], directories[2], directories[3]].map((path) => `(subpath ${quote(path)})`).join(' ')} (literal "/dev/null"))`,
    ...endpoints.map((endpoint) => `(allow network-outbound (remote ip ${quote(`${endpoint.address}:${endpoint.port}`)}))`),
    '',
  ].join('\n');
  const resolved: BoundarySpec = {
    ...spec, bundle, task: directories[0], context: directories[1], home: directories[2], temporary: directories[3],
    toolchain, authentication, executables, forbidden, endpoints,
  };
  const environment = {
    HOME: resolved.home, TMPDIR: `${resolved.temporary}/`,
    XDG_CONFIG_HOME: resolved.home, XDG_CACHE_HOME: resolved.temporary,
    XDG_DATA_HOME: resolved.home, XDG_STATE_HOME: resolved.home,
    PATH: [...new Set(executables.map(dirname))].join(':'),
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
  };
  const identity = createHash('sha256').update(JSON.stringify({ version: 1, resolved, profile, environment, heldOutEligible: false })).digest('hex');
  return { version: 1, backend: 'macos-sandbox-exec', identity, profile, resolved, environment,
    heldOutEligible: false, nativeControlsAttested: Boolean(spec.extensions.launchEvidence?.trim()) };
}
