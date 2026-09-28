# Bounded S5 boundary implementation evidence

This lane owns only `runner/boundary/`, `test/boundary-campaign.test.ts` and this
note. The full approved comparison plan and comparison spec were read. No
applicable AGENTS.md was present in this worktree or its ancestor chain. The
workflow corpus and native transports remain with their respective owners.
S0 was received by cherry-pick; the supplied selected toolkit tarball was copied
without repacking and installed with `npm ci --offline`. Its SHA-256 is
`90cc17ea030f96c83d6f77f35fbf0af1f6df7c893b65853928b7e2a60d176c9c`.
No webfront, real credential contents, paid model route, reset redemption or live
external workflow was used. Development tests do not constitute campaign results.

## Delivered policy and contract

- `runner/boundary/policy.ts`: default-deny filesystem policy, resolved positive
  task/context/toolchain/auth-file allowlist, protected-path overlap rejection,
  declared executable children, fresh HOME/XDG/tmp and exact localhost ports.
- `runner/boundary/spawn.ts`: sandbox-only spawner with admission receipt,
  boundary and argv/environment-key launch identities, safe binding allowlist,
  re-resolution around admission and an unconditional held-out refusal.
- `runner/boundary/probes.ts`: bounded actual Node/shell/tool/symlink/module/config
  probes using synthetic hidden files, plus read-only container/VM discovery.
- `runner/boundary/version-probe.ts`: no-auth/no-network `--version` startup
  probes, retaining numeric versions and whitelisted error codes only.
- `runner/boundary/README.md`: native-worker integration contract, runtime
  differences, physical-instance identity and precise G2 evidence requirements.

Generated artifacts under `runner/boundary/evidence/`:

| Artifact | Meaning |
|---|---|
| `host-policy.sb`, `host-probes.json` | Actual default-deny host policy and 18 passing no-model checks |
| `codex-version-policy.sb`, `runtime-discovery.json` | Codex offline startup; intermediate Pi failure and fallback discovery |
| `pi-version-resolved-policy.sb`, `pi-version-resolved.json` | Pi startup resolved with narrow runtime code dependencies |
| `g2-blockers.json` | Explicit held-out blocker and missing actual-route evidence |
| `initial/` | Earlier observations preserved; superseded by the root evidence artifacts and resolved Pi record |

Profiles retain actual resolved historical absolute paths; temporary bundles were
cleaned after probes. Replay by materializing a fresh bundle and recompiling the
policy, not by treating removed bundle paths as live resources. Nothing is a G2
success or native profile-equivalence claim. Authentication entries are empty in
these probes; synthetic staged-auth read success is not subscription auth proof.

## Executable observations and resolved issues

Darwin 24.6.0 x64, Node 24.21.0:

- Node directly reads/edits the assigned task and reads declared context and
  synthetic staged auth. Judge, solution, sibling and ambient-config content
  reads fail. Shell children, Node subprocess tools and symlink escapes inherit
  those restrictions. Context writes fail and unspecified network access fails.
- A synthetic local socket test proves the declared localhost port works and a
  second undeclared listening port is denied. This is not route network proof.
- Codex's actual native binary starts under the host policy and reports
  `0.155.1` with `--version`, exit 0, no auth and no network.
- Pi reports `0.0.0-overshrim`, exit 0, no auth and no network. Initial
  `ERR_MODULE_NOT_FOUND` was resolved by allowing only its `dist/bundle` code,
  exact `package.json`, entrypoint and the `@earendil-works/chord` distribution.
  No blanket Node installation, home, fixtures or research grant was added.
- dyld requires literal root-directory access; `/bin/sh` needs its selector and
  declared `/bin/bash`. These are visible boundary changes, not recursive root
  or home grants. Literal root listing and ancestor metadata remain observable.
- Docker CLI exists but its server is unavailable. Colima is stopped. Lima
  discovery found no running instance. No VM/container was silently started or
  promoted to a proven boundary. `zcode` was not on PATH; actual ACP discovery is
  native ownership, so ZCode availability/conformance remains unverified.

## G2 blockers — held-out execution must remain closed

**Host filesystem confinement is viable, but complete held-out isolation is not.**
A C tool under the host policy reads distinct synthetic argv and environment
sentinels from another same-user Node process using Darwin `KERN_PROCARGS2`.
An unsandboxed control verifies the sentinels exist. The sandboxed check confirms
both payloads without printing their contents. Literal/regex sysctl deny rules
and blanket sysctl denial did not establish isolation in exploratory checks; a
small sysctl allowlist prevented runtime startup. The final compatible policy
retains runtime sysctl access and sets `heldOutEligible: false`. The regression
checks that `heldOut: true` is refused before admission/spawn. This test passes
by detecting the limitation and preserving the closed gate.

**External endpoint restriction needs additional infrastructure.** This host's
SBPL accepts only `localhost` or `*` remote host syntax, not external IP literals.
The compiler refuses wildcard access. A separately verified localhost broker
with upstream host/port/TLS/redirect ACLs, or equivalent VM/container networking,
is needed. No broker was implemented or verified in this bounded lane.

**Actual routes, auth, extensions and frozen design remain unverified.** Offline
version/shell/socket probes never establish G1/G2. Native MCP/extension disabling
is an evidence-reference attestation only; sandboxing cannot distinguish an
extension from authorized task code executed by an allowed interpreter. Native
owners must verify effective config and disabling flags. Neither an API-key
substitute nor unrestricted reconnaissance may replace the subscription route.

## Precise orchestrator/native next steps

1. Provision and verify separate worker process isolation (dedicated identity
   that cannot inspect controller/judge processes, or a container/VM with its own
   process namespace). Mount only task, sanitized context, declared toolchain and
   minimal staged subscription auth. Exclude host sockets, hidden material,
   shared home/config, privileged mode and host PID namespace. Prove inherited
   filesystem denial and the seeded argv/env attack fails in that runtime.
2. Establish a trusted route endpoint broker or equivalent runtime egress policy.
   Verify allowlisted upstreams, TLS/hostname/redirect handling, denied external
   endpoints and absence of filesystem/connector/remote-tool APIs. Record its
   evidence hash, exact service ports and native proxy behavior. Do not grant
   wildcard network or DNS access to get a version/help command working.
3. Native owner materializes the actual Codex/Pi/ZCode code/config/tool inventory,
   hashes it and verifies effective tools, extension/MCP disabling, auth class,
   model/settings and session behavior. Keep Space Bunny's underlying identity
   anonymous. Record any differences from the configured Paseo profile.
4. For visible host calibration or isolation development, wire `spawnBoundary`
   into the sibling native `runSupervised` spawner. Pass the task cwd through the
   compiled bundle, `purpose: 'actual-route'`, **explicit `heldOut: false`**,
   declared safe environment bindings, native control reference, network control
   reference when needed, and orchestrator `admit(identity)`. Preserve stdin,
   events, process-group timeout/cancellation cleanup, thrown-error envelope and
   patch capture. Actual held-out needs a validated alternate spawner; this host
   wrapper has no held-out override.
5. Before any model call, orchestrator supplies refreshed quota/workboard
   admission, bounded assignment and GLM blackout checks. Run actual `runSuite`
   conformance on the same visible verified task for G1. Retain absent routes.
6. In the final isolated runtime, run each actual final native/diagnostic strategy
   against hidden judge/solution/sibling/config sentinels via filesystem, shell,
   symlink/absolute path, native tools, extension/MCP paths and ambient discovery.
   Verify authorized task/dependency/subscription auth still works and undeclared
   tools/endpoints fail. Retain private events plus sanitized policy/allowlist/
   executable/config/broker hashes and exact invocation identities. Only the
   orchestrator can combine this evidence with the frozen final design for G2.

## Validation

`npm run typecheck` and `npm run lint` pass. The focused boundary suite passes all
8 tests, including 18 executable checks, actual local port semantics, offline
Node startup, exact admission failure cases and the seeded process-channel
limitation plus held-out refusal.

The initial default-concurrency `npm test` built successfully and finished with
529 passes / 9 timeouts in existing runner, lock and snapshot-regrade tests.
These were timeout errors (5s/15s/120s), not boundary assertion failures. A subsequent
full run with two Vitest workers is recorded below; no existing test timeout,
fixture, oracle, baseline or implementation outside ownership was modified.

The two-worker run built successfully and recorded 59 passes / 2 timeouts in
`test/runner.test.ts`: check exit scoring and the independent check-timeout
ceiling (both 15s limits; observed 19.109s and 17.359s). Its retained log has
no final suite summary. At finalization no boundary npm/Vitest process remained;
this run is incomplete, not a full-suite pass. No further full-suite rerun was
performed after the overseer steer. Bounded excerpts are retained in
`runner/boundary/evidence/validation.log`.

Final focused verification passed 3 files / 15 tests: boundary campaign, selected
toolkit package smoke, and existing boundary tests (3.71s). Typecheck and lint
passed on the final implementation. No paid model calls were made.

## Authorized VM/container follow-up

Dedicated `cq-boundary-s5` Colima/VZ profile provisioned successfully in 132.53s:
2 CPUs, 3 GiB memory, 8 GiB root / 12 GiB data disk. It has no host filesystem
mounts, SSH-agent forwarding or public port forwards. Existing default profile
remains stopped and global Docker context unchanged. Dedicated VM remains running
for the parent/native owner; temporary probe containers/volumes/networks/helpers
and synthetic files were removed. Local runtime images remain on this daemon.
No real auth was read/copied, no public service/push and no paid model calls.

Concrete implementation and native seam: `runner/boundary/container.ts`,
`container-prepare.ts`, `namespace-acl.sh`, `egress-broker.ts` and `FALLBACK.md`.
Preparation verifies live daemon/config/image/volume/network inventory, starts a
harmless gate, installs exact broker-only IPv4 plus default-deny IPv6 ACLs, checks
read-back, and returns a specific container/identity/cleanup receipt. Native
supervision must dispose the container on timeout/cancel/error/finally; killing
the host Docker client alone does not kill native descendants.

Final synthetic qualification: **59 / 59 checks passed** in 38.84s,
including positive sibling argv/env/file controls, host/VM/sibling judge/solution/
config denial via direct/tool/shell/symlink children, absent external process
sentinels, non-root/capability/seccomp checks, default network and embedded DNS
denial, allowed HTTPS broker route and rejected TLS mismatch/redirect/undeclared
route/absolute URL/CONNECT. Actual TypeScript preparation also passed and ran
Node v24.21.0 in a fresh verified container before disposal.
The initial adapter refused combined NAT/filter read-back; that rejection is
retained separately. The corrected script reads only enforced filter tables.

Linux runtime image: `sha256:2a9422f0de75079fd81da5a5b68bf9936e72ce22e30d1a22ddd91bc77201de4e`.
Codex 0.155.1 and installed Pi 0.0.0-overshrim version probes exit 0 offline;
ZCode ACP server 0.37.3 package installs and `--help` exits 0 offline. Pi's
unpublished version was resolved by copying only its explicit distribution plus
Chord runtime subset (152 content-hashed files). These are startup observations,
not auth/subscription, model, ACP-session, native-tool or actual-route G1 proofs.
Runtime provisioning took 99.01s; auth is absent and network disabled for startup.

The original host `heldOutEligible:false` and sysctl blocker remain unchanged.
VM availability and synthetic namespace/egress controls are now resolved for this
candidate. **G2 remains not established**: production provider/auth-refresh broker,
reverse-base-URL subscription compatibility, sanitized native extensions/config,
actual selected-toolkit G1 and admitted final actual-route sentinel evidence are
still required. Both launch seams refuse held-out work. Synthetic test CA/private
upstreams are ineligible for actual-route admission; production host/IP/TLS/paths/
headers, image/daemon/VM/config/volume identities must be frozen into the strategy.

See `runner/boundary/FALLBACK.md` for precise staging, native transport, endpoint,
cleanup/patch-export and admission steps. Safe JSON/rule/config artifacts are in
`runner/boundary/evidence/fallback/`; no credential payload is retained.
Final follow-up build, typecheck and lint pass. Focused campaign/package-smoke/
existing-boundary verification passes 3 files / 19 tests in 1.96s. No full-suite
rerun was performed; the earlier 9 timeout failures and incomplete two-worker
rerun remain recorded above and in the bounded validation log.

2026-09-29 trusted staging/export follow-up (no model calls):
`stageTaskClone` binds exact independent clone HEAD, sanitized Git metadata and full
private task/context inventory to exclusive labeled volumes. Labels without bytes
are rejected. `containerTaskSession` requires awaited container teardown and absence
read-back before reading only task volume. Fresh export preserves candidate commits,
baseline ancestry, deletions, executable modes, safe links and untracked partial files.
Receipts include file contents and remain private; do not serialize real receipts into
logs. Independent read-only review and fixes are recorded in
`runner/boundary/evidence/fallback/staging-review.md`.

Real dedicated-VM synthetic lifecycle passes in 4.746 seconds using utility image
`sha256:4a14ba40f65117679e6f60d0f7f7bfa5eb44ff9be79e96137966a1ba9675f9b0`:
valid labels with altered bytes rejected; timed Docker exec client kill followed by
container removal; partial candidate export retains commit/modes/deletion/untracked
state; hidden-path symlink rejected. Private probe volumes/containers removed. VM
bounds unchanged at 2 CPU / 3 GiB, no others' configuration changed. Utility build
(node pinned base plus git/CA packages) took 19.23s; image content ID is qualification
identity, not a promise of reproducible apt package resolution.

G2 remains blocked. Native owner must first finish visible G1, then extend honest
boundary-unverified spawn receipts and async termination/finalization hooks in
runSupervised. Its Docker-client process-group kill alone cannot stop Linux children.
After native image/config/auth inventory and HTTP/WS/refresh compatibility are pinned,
freeze exact broker host/IP/TLS/path/header identities; obtain parent admission;
run actual native tool/shell/symlink/process/config/endpoint sentinels through that
final route. No shell-only result establishes G2. Disabled credential-free endpoint
source/schema notes are in `runner/boundary/provider-route-templates.json`.

No full-suite rerun: earlier 529 passes / 9 runner-test timeouts and incomplete
2-worker run remain the prior bounded evidence, investigated separately by parent.
Final focused boundary suite: 16/16 tests pass in 1.73s. Build/typecheck/owned-file
lint pass. An initial new Git preservation test exceeded Vitest's default5s during
host contention (12.132s); only that bounded test now has a30s ceiling and subsequent
runs pass. Full-suite timeouts were not rerun or reclassified as passing.
