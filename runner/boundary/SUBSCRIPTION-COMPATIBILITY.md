> Final parent-selected profile and access-only lifecycle supersede the earlier refresh-bearing context described below: see [CODEX-HTTP-HANDOFF.md](./CODEX-HTTP-HANDOFF.md). No shared refresh token may be staged for this candidate.

# Subscription reverse-broker qualification (no generation)

Codex 0.155.1 is compatible with the reverse broker for authenticated model-catalog
metadata on this dedicated Linux VM. Both built-in `openai_base_url` override and
an explicitly HTTP-only custom provider received GET `/backend-api/codex/models`
HTTP200. Broker observations contain only method/path classification, bearer/account
header presence and status. OAuth fields and credential digests are never public
artifacts. No inference route was enabled and no model turn was submitted.

Installed macOS package/CLI and pinned Linux runtime are both0.155.1. Primary source
is the exact `rust-v0.155.1` release tag, not current docs. Source URLs and SHA256 are
in `evidence/fallback/subscription-source.json`. Key source semantics:

- `model-provider-info/src/lib.rs:350-368`: ChatGPT auth selects the Codex backend;
  explicit provider base URL takes precedence without changing authentication.
- `model-provider-info/src/lib.rs:443-477`: built-in OpenAI provider has no env key,
  requires OpenAI auth and supports WebSockets. Base URL alone does not force SSE.
- `model-provider/src/auth.rs:197-221,310-328`: managed ChatGPT tokens produce bearer
  plus account headers. A custom provider must retain `requires_openai_auth=true`.
- `login/src/auth/manager.rs:200-202,1598-1621,1733-1735`: refresh is JSON POST to
  `https://auth.openai.com/oauth/token`; `CODEX_REFRESH_TOKEN_URL_OVERRIDE` selects
  the endpoint. `openai_base_url` does not reroute refresh.
- `codex-api/src/endpoint/models.rs`: catalog is GET `/models` with client-version
  query. `codex debug models` is metadata only. This installed CLI rejects
  `--strict-config` for that command; the first three startup attempts therefore
  sent no broker request. Removing the unsupported flag resolved the failure.

`privateCodexAuthContext` reads only the exact plain host `.codex/auth.json`, keeps
managed OAuth token fields and refresh metadata, explicitly nulls API-key auth, and
writes auth plus a private content-hash inventory under a0700 parent-owned temporary
context with0600 files. The qualification mounts only its auth file volume read-only;
Codex copies it into fresh tmpfs home for its own writable cache/auth bookkeeping.
No host home/config/socket is mounted. Credential hash verification happens privately
against live volume contents; hashes never enter committed public evidence. Real
refresh was not enabled or exchanged. Original host auth is never modified.

`subscription-qualify.ts` performs offline Linux `login status` then authenticated
catalog only. Worker namespaces have IPv4/IPv6 default-deny ACLs allowing just the
brokerIP/port; worker DNS is denied. Broker alone connects to VM bridge egress, with
fixed TLS hostname and resolved/pinned public IPv4s, certificate verification,
redirect rejection, no CONNECT/Upgrade and exact catalog pathname. Probe containers,
network, auth volume and broker tags are removed afterward. Private parent contexts
remain for controlled native handoff; do not mount or serialize their inventory into
workers. Run from source after build; no model-capable command is accepted.

HTTP-only choice changes identity: dedicated `model_provider="cq-subscription-http"`,
`wire_api="responses"`, `requires_openai_auth=true`, `supports_websockets=false`,
custom base URL. It remains managed subscription auth, but differs from built-in
OpenAI provider name/capabilities/identity and must be an explicitly labeled profile.
Native owner must rerun G1 under that final profile. Keeping the built-in provider
instead requires separately reviewed exact-host WebSocket support or a proven native
SSE control. Existing broker intentionally rejects Upgrade.

Synthetic TLS SSE test proves chunks pass before upstream completion; it is not a
native Responses streaming turn. Public metadata artifacts record built-in success
22.393s and HTTP-only success12.079s. They establish read-only auth/header/DNS/TLS/
base-URL compatibility, not G2, quota parity, token refresh portability or native
inference/tool behavior.

Next actual-route work remains gated:

1. Parent chooses HTTP-only profile or fixed-host WebSocket implementation; freeze
   image, dedicated config, auth inventory, extensions and broker identity. Use exact
   models/responses paths and separately declared refresh host/path; templates remain
   disabled. Never grant the whole external hostname or arbitrary CONNECT.
2. Native owner completes visible G1 and awaited container teardown/export hooks.
   Declare refresh override explicitly in launch/config identity. Keep refreshed auth
   private and do not propagate mutations back to host credentials. A live refresh
   qualification needs a coordinated disposable/native-owned credential lifecycle:
   refresh rotation can affect other clients using the same host refresh token.
3. Parent admits actual route before any model turn. Then qualify native SSE or WS,
   refresh recovery, model/tool/shell/symlink/config/process sentinels and unauthorized
   endpoint denial using final route. No metadata/shell-only evidence admits G2.

Pi follow-up is independently bounded: configured campaign route is
`opencode-go/space-bunny-free`. Its checked `.pi/agent/auth.json` has no Go entry;
conventional `.local/share/opencode/auth.json` is absent. No broader home search or
OpenAI OAuth substitution was performed. Native owner must identify exact Go auth
and extension/config handoff. Declared Pi source advertises Go bases under
`https://opencode.ai/zen/go[/v1]`; final model route/API schema requires the chosen
provider registry entry. Alternate OpenAI OAuth adapter has hard-coded
`https://auth.openai.com/oauth/token`, no refresh override observed, and supports
`options.transport="sse"`; these are facts about an alternate route, not qualification
of Go/Space Bunny. Source hashes are in disabled route templates.
