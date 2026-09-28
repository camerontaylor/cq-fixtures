import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface BrokerRoute {
  id: string;
  hostname: string;
  port: number;
  pathPrefix: string;
  /** Optional exact pathname set, required for production native route templates. */
  exactPaths?: string[];
  methods: string[];
  /** Fixed destinations, never supplied by a worker request. */
  addresses: string[];
  requestHeaders: string[];
}
export interface BrokerConfig {
  routes: BrokerRoute[];
  timeoutMs: number;
  maxBodyBytes: number;
  /** Synthetic TLS test trust only; cannot be admitted as a production broker. */
  synthetic?: { ca: string };
}

function publicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
}

export function compileBroker(config: BrokerConfig): { config: BrokerConfig; identity: string; productionEligible: boolean } {
  const copy: BrokerConfig = structuredClone(config);
  if (!Number.isInteger(copy.timeoutMs) || copy.timeoutMs < 100 || copy.timeoutMs > 300_000 ||
      !Number.isInteger(copy.maxBodyBytes) || copy.maxBodyBytes < 1 || copy.maxBodyBytes > 32 * 1024 * 1024) {
    throw new Error('broker requires bounded time and body size');
  }
  const ids = new Set<string>();
  for (const route of copy.routes) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(route.id) || ids.has(route.id) ||
        !/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(route.hostname) || isIP(route.hostname) ||
        !Number.isInteger(route.port) || route.port < 1 || route.port > 65535 ||
        !/^\/[a-zA-Z0-9/_-]*$/.test(route.pathPrefix) || route.pathPrefix.includes('//') ||
        (route.exactPaths !== undefined && (!route.exactPaths.length || new Set(route.exactPaths).size !== route.exactPaths.length || route.exactPaths.some((p) => !/^\/[a-zA-Z0-9/_-]*$/.test(p) || p.includes('//') || !(p === route.pathPrefix || p.startsWith(route.pathPrefix.endsWith('/') ? route.pathPrefix : route.pathPrefix + '/'))))) ||
        !route.methods.length || route.methods.some((m) => !['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(m)) ||
        !route.addresses.length || route.addresses.some((a) => isIP(a) !== 4 || (!copy.synthetic && !publicIPv4(a))) ||
        route.requestHeaders.some((h) => !/^[a-z][a-z0-9-]*$/.test(h) ||
          ['host', 'connection', 'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'upgrade', 'forwarded'].includes(h))) {
      throw new Error('broker route must declare exact TLS host, IPs, paths, methods and safe headers');
    }
    ids.add(route.id);
  }
  return { config: copy, identity: createHash('sha256').update(JSON.stringify(copy)).digest('hex'), productionEligible: !copy.synthetic };
}

/** Reverse-only HTTP broker. Fixed HTTPS targets; no CONNECT, absolute URLs or redirects.
 * Run separately from workers, with config unavailable to them. Never log request data.
 */
export function createEgressBroker(input: BrokerConfig) {
  const policy = compileBroker(input);
  const server = createServer((req, res) => {
    const reject = (status: number) => { res.writeHead(status); res.end(); req.resume(); };
    const raw = req.url ?? '';
    if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\r\n]/.test(raw) || /%(?:2f|5c|2e)/i.test(raw)) return reject(403);
    const match = /^\/route\/([a-z][a-z0-9-]*)?(\/[^#]*)$/.exec(raw);
    if (!match) return reject(403);
    const route = policy.config.routes.find((r) => r.id === match[1]);
    const path = match[2];
    const pathname = path.split('?')[0];
    if (!route || !route.methods.includes(req.method ?? '') || (route.exactPaths && !route.exactPaths.includes(pathname)) || pathname.includes('//') ||
        pathname.split('/').some((p) => p === '.' || p === '..') ||
        !(pathname === route.pathPrefix || pathname.startsWith(route.pathPrefix.endsWith('/') ? route.pathPrefix : route.pathPrefix + '/'))) return reject(403);
    if (req.headers.upgrade || req.headers['proxy-authorization']) return reject(403);
    const declaredLength = Number(req.headers['content-length'] ?? 0);
    if (!Number.isFinite(declaredLength) || declaredLength > policy.config.maxBodyBytes) return reject(413);
    const headers: Record<string, string | string[]> = {};
    for (const name of route.requestHeaders) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    const upstream = request({
      protocol: 'https:', hostname: route.hostname, servername: route.hostname, port: route.port,
      path, method: req.method, headers, rejectUnauthorized: true,
      ca: policy.config.synthetic?.ca,
      // No worker-controlled resolver, IP, Host or SNI. Pin the resolved IPv4 inventory.
      lookup: (_hostname, options, callback) => {
        // Modern Node may request all addresses for family autoselection.
        if (typeof options === 'object' && options.all) callback(null, route.addresses.map((address) => ({ address, family: 4 })));
        else callback(null, route.addresses[0], 4);
      },
      agent: false,
    }, (response) => {
      if ((response.statusCode ?? 502) >= 300 && (response.statusCode ?? 502) < 400) {
        response.destroy(); res.writeHead(502); res.end(); return;
      }
      const safe: Record<string, string | string[]> = {};
      for (const name of ['content-type', 'cache-control', 'retry-after']) {
        if (response.headers[name] !== undefined) safe[name] = response.headers[name];
      }
      res.writeHead(response.statusCode ?? 502, safe); response.pipe(res);
    });
    const timer = setTimeout(() => upstream.destroy(new Error('bounded upstream timeout')), policy.config.timeoutMs);
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > policy.config.maxBodyBytes) { upstream.destroy(); if (!res.headersSent) res.writeHead(413); res.end(); }
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    upstream.on('close', () => clearTimeout(timer));
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  server.requestTimeout = policy.config.timeoutMs;
  server.headersTimeout = Math.min(10_000, policy.config.timeoutMs);
  return { server, identity: policy.identity, productionEligible: policy.productionEligible };
}

/** Operator-side discovery only; returned addresses become immutable broker inventory. */
export async function resolveBrokerHost(hostname: string): Promise<string[]> {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(hostname) || isIP(hostname)) throw new Error('exact hostname required');
  const addresses = (await lookup(hostname, { all: true, family: 4 })).map((r) => r.address);
  if (!addresses.length || addresses.some((a) => !publicIPv4(a))) throw new Error('upstream must resolve only to public IPv4 inventory');
  return [...new Set(addresses)].sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8')) as BrokerConfig;
  const broker = createEgressBroker(config);
  broker.server.listen(8080, '0.0.0.0');
}
