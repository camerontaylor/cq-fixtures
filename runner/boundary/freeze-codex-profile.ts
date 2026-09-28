/** Operator-only public production assets; never reads credentials or starts workers. */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DockerControl } from './docker-control.ts';
import { compileBroker, resolveBrokerHost } from './egress-broker.ts';
const runtime = 'sha256:2a9422f0de75079fd81da5a5b68bf9936e72ce22e30d1a22ddd91bc77201de4e';
const template = JSON.parse(readFileSync(new URL('./provider-route-templates.json', import.meta.url), 'utf8'));
const route = template.codex.inactiveRoutes[0];
route.addresses = await resolveBrokerHost('chatgpt.com');
const config = { routes: [route], timeoutMs: 300000, maxBodyBytes: 32 * 1024 * 1024 };
const policy = compileBroker(config);
const directory = mkdtempSync(join(tmpdir(), 'cq-s5-frozen-profile-'));
const assets: Record<string, string> = {
  'config.json': JSON.stringify(config),
  'broker.js': readFileSync(new URL('../../dist/boundary/egress-broker.js', import.meta.url), 'utf8'),
  'config.toml': 'model_provider="cq-subscription-http"\ncli_auth_credentials_store="file"\n[model_providers.cq-subscription-http]\nname="CQ HTTP-only managed subscription"\nbase_url="http://172.29.249.2:8080/route/codex/backend-api/codex"\nwire_api="responses"\nrequires_openai_auth=true\nsupports_websockets=false\n',
  'Dockerfile': `FROM ${runtime}\nCOPY broker.js /opt/broker.mjs\nCOPY config.json /opt/config.json\nENTRYPOINT ["/usr/local/bin/node","/opt/broker.mjs","/opt/config.json"]\n`,
};
for (const [name, body] of Object.entries(assets)) writeFileSync(join(directory, name), body, { mode: 0o600 });
const control = new DockerControl();
try {
  await control.run(['build', '--network=none', '-t', 'cq-s5-codex-http-broker:frozen', directory]);
  const image = await control.run(['image', 'inspect', 'cq-s5-codex-http-broker:frozen', '--format', '{{.Id}}']);
  const receipt = { directory, image, runtime, brokerIdentity: policy.identity, assets: Object.fromEntries(Object.entries(assets).map(([name, body]) => [name, createHash('sha256').update(body).digest('hex')])), addresses: route.addresses, parentAdmissionRequired: true, G2: 'pending', authIncluded: false };
  writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(receipt));
} finally { control.close(); }
