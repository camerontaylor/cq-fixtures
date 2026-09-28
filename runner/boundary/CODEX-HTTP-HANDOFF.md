# Final candidate: HTTP-only managed subscription

This custom provider is an explicit campaign identity change; it makes no built-in native parity claim. G1 must rerun on this final container/profile. G2 awaits parent admission and actual native tools, shell, symlink, config, process and unauthorized endpoint probes. No generation was performed by this lane.

Frozen public asset directory: `/Users/ctaylor/.tmp/cq-s5-frozen-profile-3AQYGq`. `receipt.json` pins each source/config asset; committed `evidence/fallback/codex-http-frozen.json` pins the same hashes and image. Use immutable broker image `sha256:a0af04214c67a25e4c5ab01b20f6e6deea98fc664b65ae5532576949234adfe3`, not a floating tag. Runtime remains `sha256:2a9422f0de75079fd81da5a5b68bf9936e72ce22e30d1a22ddd91bc77201de4e`. No auth enters either image/build context.

```toml
model_provider="cq-subscription-http"
cli_auth_credentials_store="file"
[model_providers.cq-subscription-http]
name="CQ HTTP-only managed subscription"
base_url="http://172.29.249.2:8080/route/codex/backend-api/codex"
wire_api="responses"
requires_openai_auth=true
supports_websockets=false
```

Broker identity `c6d8d0b3dba5ac98779663e4cc75b92107fddb14430fc42180f4ec675c0f99b0`: TLS upstream chatgpt.com:443 with SNI/certificate validation; pinned IPv4 104.18.32.47 and 172.64.155.209. Only GET `/backend-api/codex/models` (native client_version query accepted) and POST `/backend-api/codex/responses` are allowed. Responses stream incrementally; timeout 300000ms, body cap 32MiB. All other methods/paths/routes, CONNECT, upgrades, encoded traversal and redirects fail. No auth.openai.com or refresh route. DNS change requires a new frozen identity and qualification; no wildcard fallback.

Native launch contract:

1. Use `privateCodexAuthContext(true)` immediately before staging; never log returned auth or private inventory. It reads only the exact host auth file without following links, copies access JWT and required account routing metadata, sets `auth_mode="chatgptAuthTokens"`, clears refresh_token and API key, and uses that same access JWT as token-info input. Original ID/refresh tokens are absent. Directory0700, files0600, credential inventory hash PRIVATE parent-owned.
2. Stage only auth.json plus the frozen config.toml into an exclusive context volume through the trusted content-inventory staging contract. Never mount host auth/home/socket. Keep inventory.json outside candidate context. Copy auth/config into fresh worker CODEX_HOME (0700/0600); allowlist HOME, CODEX_HOME, PATH only plus explicitly reviewed native variables. No external auth refresher/callback, API-key environment, refresh override or inherited config.
3. Access-token exp must exceed the launch budget plus120s. Maximum run900s; stage immediately, recheck expiry at actual launch, account for all queue time, and stop at deadline. Native supervisor must enforce this timer; helper alone does not enforce process lifetime. Expiry/401 ends the attempt; restage a current host access token only through parent control. Never live refresh shared tokens. Dedicated independent credentials are required if native refresh becomes necessary.
4. Dedicated internal subnet172.29.249.0/24: trusted broker.2 worker.3, broker8080. Broker may join VM bridge; worker may not. No public ports. Label broker container `cq.boundary.broker` and supply image ID/config `/opt/config.json` to preparer. Install/verify namespace ACL before gate release; worker DNS and all egress except broker IP/port denied. Keep existing 2CPU3GiB VM resource identity, nonprivileged worker, no undeclared mounts/extensions.
5. Use native runSupervised hooks with containerTaskSession: teardown container and verify absence BEFORE export; inspect only task via safe traversal, verify baseline, preserve partial patch/commits/modes/deletions/untracked files. Then delete private task/context volumes and private auth directory only after successful export. Failed export retains private recovery data for parent cleanup. Teardown broker/network when unused; retain immutable images/public assets for reproducibility.

Exact installed source tag rust-v0.155.1: [auth manager](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/login/src/auth/manager.rs) lines383–398 load external-token mode;1739–1769 construct access-only state;1793–1795 select ephemeral storage;2852–2889 do not run managed refresh for ChatgptAuthTokens absent an external authority. [provider auth](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/model-provider/src/auth.rs) lines197–221 and310–328 retain subscription bearer/account headers when requires_openai_auth=true. Source and offline/catalog runtime checks establish no-spend compatibility only; actual responses/native control remains unqualified.

Final retained private qualification context: `/Users/ctaylor/.tmp/cq-s5-subscription-private-c1s42R` (parent-owned, do not commit/log inventory). This supersedes earlier managed-refresh and provisional contexts. Restage immediately before admission if expiry budget is insufficient. Offline Linux login recognized subscription and rejected API-key mode; exact authenticated models GET200 completed4.709s. Public evidence: `evidence/fallback/subscription-access-only-metadata.json`. Focused21/21 tests1.58s; build/typecheck/owned lint passed. No full-suite rerun.
