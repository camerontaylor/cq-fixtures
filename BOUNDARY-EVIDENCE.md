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
