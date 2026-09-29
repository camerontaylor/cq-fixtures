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

2026-09-29 subscription compatibility follow-up: exact Codex0.155.1 primary source
and actual dedicated-VM managed-auth catalog qualify reverse-baseURL semantics.
Built-in override and explicit HTTP-only custom provider both return authenticated
catalog GET200 with bearer/account header presence, API-key auth absent, worker DNS
blocked and broker-only namespace egress. Zero generation routes/model turns; no live
refresh exchange. Minimal auth0600 and private hash inventory remain parent-owned,
never emitted/committed. Public JSON records only sanitized status/booleans/identity.

See `runner/boundary/SUBSCRIPTION-COMPATIBILITY.md` for source refs, runtime/profile
identity effects, refresh override, streaming limits and gated next steps. HTTP-only
provider metadata passes12.079s; built-in passes22.393s. Initial strict-config failures
sent no network request: installed CLI explicitly rejects that flag for debug models.
Broker now supports exact pathname allowlists, with adversarial subpath rejection and
synthetic TLS incremental SSE tests. Focused19tests pass3.42s; no full-suite rerun.
G2 still blocked until native G1/final hooks/config/auth control and parent admission
plus actual-route tool/sentinel evidence. Configured Pi Go auth unavailable in the
checked exact stores; no alternate-provider substitution or blanket home search.

Final HTTP-only candidate handoff: `runner/boundary/CODEX-HTTP-HANDOFF.md` and frozen broker receipt `runner/boundary/evidence/fallback/codex-http-frozen.json`. Exact endpoint-method ACL now separates GET models from POST Responses; no refresh route. Access-only external-token context excludes original ID/refresh tokens and API keys, with 900s scheduling budget+120s expiry margin. Native supervisor must recheck launch expiry and enforce deadline. Synthetic tests cover wrong methods, undeclared paths/routes, encoded paths, forbidden redirects and incremental TLS SSE chunks. No model turns or shared-token refresh; G2 pending, final-profile G1 required. Previously recorded full-suite runner-test timeouts remain unresolved by this bounded lane and were not rerun.

Final-container implementation seam: `runner/boundary/codex-final-profile.ts`, `g2-sentinel-design.json`, updated HTTP handoff. Host visible G1 accepted by parent e37b2b2 is evidence for the host identity only; final container/custom HTTP profile G1 not run. Parent has admitted implementation only, not a final-profile turn. Fresh access-only payload and private inventory retained parent-owned; no secrets printed and no live shared refresh performed. Native lane bba1c310 briefed via Paseo on receipt widening, exact CLI overrides, host-to-/task mapping, awaited teardown/export and distinct stage-bound admission. Focused24/24 tests13.42s, build/typecheck/owned lint passed prior to final defensive close-hook addition; final checks follow below. Full suite not rerun; earlier runner-test timeouts remain recorded. G2 pending.
Final focused tests after defensive teardown/admission-recheck changes:24/24 passed12.10s. No full-suite rerun. Frozen producer image/config remains unchanged; actual final CLI override startup/native transport await final-profile admission, so current helper/metadata evidence does not qualify final-profile G1 or G2.

Flash review F2–F5 owned fixes: hard-pin native worker image2a9422f0 alongside frozen broker; preserve/rethrow first termination error; stop already-exited child; finally close trusted client control after export/cleanup failure while retaining available private recovery volumes. F1 authoritative preregistration/exclusive wx replay ledger remains parent-owned and explicitly required by callback contract. Admission is consumed by provision failure; whole-provision deadline remains native owner responsibility. Public independent pin inputs: runner/boundary/evidence/fallback/final-profile-public-inputs.json. No model calls or native edits.
Final review-fix validation:28/28 focused tests passed28.70s; build, typecheck, owned-file lint and diff checks passed. Earlier intermediate lint/typecheck failures (timer declaration and synthetic child event shape) corrected before final checks. Native lane reports paused/uncommitted edits and focused failures; no native readiness or whole-provision deadline claim made by boundary lane. No full-suite rerun and no model calls.

### Actual-route harness and post-export candidate boundary (no model dispatch)

Added `g2-harness.ts`, its prepare/scan/cleanup CLI, canonical native receipt normalizer and public source manifest. Private synthetic files and a separate nonprivileged guardian provide judge/solution/sibling/config/process sentinels without modifying ambient credentials/config. The prompt requires exact native read/search/http/config channels alongside shell/child/symlink/process/network probes and positive task read/write controls. Missing or ambiguous correlated native events fail closed; JSON-only scanning always remains synthetic. Sentinel scans report only booleans, including split chunks and base64/hex variants. Parent must supply a distinct authoritative actual-route-G2 ledger admission after accepted final-container G1. No model calls performed.

The workflow boundary now explicitly includes post-export execution of candidate product modules. `judge-child.ts` stages only a safe bounded candidate snapshot into an exclusive private volume, then executes bounded behavioral requests in a nonprivileged network-none read-only container with private process namespaces and no auth/host mounts. Hidden references remain parent-side; candidate stdout remains private/untrusted and must never enter model context. S0 must adapt actual semantic oracle callers; unrestricted host candidate execution blocks whole-workflow G2. Synthetic executor results are recorded separately and cannot grant actual-route qualification.

Focused boundary tests/build/typecheck/owned-file lint are used; the previously recorded full-suite runner-test timeouts remain unresolved and the unbounded suite was not rerun. Existing final frozen runtime/broker/network/auth identity remains unchanged. No native-owned source edits, model turns or hidden oracle contents are included in this handoff.

Live protected-executor probe: public control and synthetic protected-read/child-read/read-only-write denial passed; timeout disposal and namespace absence passed (`evidence/fallback/judge-child-synthetic.json`, modelCalls=0). Initial staging EACCES was resolved with `volume-nocopy` on the fresh candidate volume, retaining only CHOWN for trusted staging. No capability widening or host configuration mutation was needed.

Final owned verification: build, typecheck and boundary/test lint passed; focused boundary suite 34/34 passed in 14.55s. Full suite was not rerun.

### Runnable private final-container G1 runtime and exact workspace publication

Added no-dispatch `prepare-final-g1-runtime.mjs` and a private runtime factory. Preparation independently freezes source/assignment/public profile pins, creates exclusively labelled dedicated broker/internal network, validates daemon/VM/images/live broker/config, and safely stages a fresh access-only subscription context. Parent approval is absent by default: the emitted template is approved:false. Runtime validates exact intended task file hashes, ordinary canonical assigned workspace and safe baseline, independently derives expected boundary/invocation from its own staged specification and reviewed public launch arguments/bootstrap/budget, then compares callback requests against the already frozen private expected identities. Sensitive content inventories/hashes stay private. No token refresh, ambient config changes or model calls.

Resolved a concrete capture/export mismatch: runSuite judges its assigned cwd, while safe export requires an empty directory. When exportRoot equals that exact hostTaskRoot, the final adapter exports only after namespace absence into a same-filesystem fresh sibling, then validates unchanged pristine source and exact stopped-export inventory/HEAD and publishes by two renames. Canonical paths, symlink ancestors, parent ownership/write permissions, baseline changes and export aliases are checked. Original source backup and0600 hashed recovery manifest are retained for parent acceptance; failure restores source when possible and otherwise retains complete original/candidate trees. Candidate code is never executed on host; S1's separate capture gitDir is unaffected and the ordinary worker .git is preserved.

Native setup cancellation remains explicitly unsupported until its owner propagates factory/setup rejection: runtime uses its own earlier absolute setup cutoff, rejects/cleans late stage receipts on return, provides a deadline cleanup lease and exposes no-dispatch owned-resource cleanup. Individual Docker operations are bounded but cannot be promptly interrupted by this runtime. Default cleanup retains handed-off task/context/auth recovery; explicit parent recovery disposition may remove exclusively owned remaining volumes/auth. Publication backups stay private for separate acceptance. No whole-workflow G2 qualification is implied.

Publication verification: focused boundary suite40/40 passed in4.37s; build/typecheck and owned lint passed during the implementation checks. Tests cover committed edits, deletions, untracked files, executable modes, original backup retention, host mutation and identity/alias/symlink/shared-parent refusal, candidate rename rollback and complete original retention when rollback itself fails. Full suite was not rerun.

### Public broker toolchain correction (2026-09-29)

The pinned broker image's original root-owned mode-0600 `/opt` assets cannot be read by the required nonroot process. Production now uses strategy `nonroot-public-toolchain-v2`: exactly two PUBLIC pinned code/config files in a newly created exclusively labelled named volume, mounted read-only at `/opt`; no auth, additional mounts, host binds or root broker fallback. Actual broker-process reads verify file bytes, inventory, permissions and exclusive volume ownership. Worker admission additionally requires this effective broker runtime identity, alongside live daemon, image, network, arguments and user checks. Earlier public inputs are retained in `final-profile-public-inputs-before-broker-toolchain.json`; the unchanged image does not preserve the former boundary identity.

Effective broker identity: `a0271b61483a1c253b86884ce054793d58d3e66e42f020d6d0434101ca869fe8`. Public asset inventory: `e7263ccbc3bd0fe0b82c08b7c1959fae20afbda381a0d2310fdb1842e272e506`. Build/typecheck/owned lint passed; 43 focused boundary tests passed (23.14 seconds), including altered asset content with valid labels, writable/redirected/additional auth mounts, and image/user/argument/label substitution refusal. No full-suite rerun or model calls.

No-dispatch private preparation against integration `d1838ec` succeeded using independently materialized review-v2 task inventory (`settings/module.js`, `settings/display.js`, package and public test). Fresh access-only subscription context is private; no refresh or credential values are published. Approval is disabled and source pins explicitly provisional until broker correction and native cancellation correction are integrated. Docker staging calls remain individually bounded but not interruptible; runtime self-checks its earlier setup cutoff and cleans late results. Actual-route G2 and whole-workflow protected judge qualification remain pending, including the separately identified G2 evidence evaluator corrections. The earlier full-suite timeouts remain unresolved and are not represented as a pass.

Native setup/publication seam amendment: preparation now respects the supplied earlier setup deadline rather than assuming it is the assignment deadline. `cleanupInvocation` waits for in-flight staging to settle before disposal proof and refuses elapsed cleanup deadlines; native timeout must retain unknown resource disposition. Successful publication returns destination, independently Git-verified baseline commit/tree and host-unchanged/after-teardown/capture-eligible flags only after rollback-safe publication. Whole-assignment resource lifetime remains explicitly unsupported for frozen-lane eligibility. The preceding private module generation is inspection/cleanup only and must be regenerated after integration; its factory source pin deliberately rejects subsequent source edits.

### G2 evidence review corrections and failed pre-dispatch G1 cleanup

Parent's G1 attempt failed before dispatch because the private runtime overrode native's existing authenticated AggregateQuotaSource with a null result. Exact owned `w0ahtf` cleanup with `removeRecovery:true` returned `infrastructureDisposed:true`, `recoveryRetained:false`. Commit `75a45be` removes the override; its actual-factory no-dispatch regression proves the returned options omit `quotaSource`. Native owns authenticated-default scheduling/null-denial regression. No quota capacity is manufactured, no refresh exchange occurs, and the retired module/approval must not be reused.

G2 pure `evaluateG2` is diagnostic only and always refuses worker/whole-workflow qualification. Only `runG2Harness` may qualify after authoritative consumed-ledger validation and independent stopped-export audit. Missing actual status/errno/control corroboration cannot establish denial; typed claims or empty outputs alone fail closed. Canonical receipt normalization retains export inventory/hash HEAD, compared with independently snapshotted file content and Git HEAD against the preregistered baseline before qualification. Effective broker mount strategy identity is required. Private failure records retain only whitelisted cause class/code and phase, not exception messages. Dedicated daemon pinning is deliberate and a different daemon requires fresh evidence/public inputs/admission.

Validation: build/typecheck/owned lint passed. Changed G2 plus quota factory subset: **9 passed, 38 skipped**, 1.42 seconds; synthetic tests do not grant actual-route evidence. Earlier owned boundary run: 40 passed/5 default-five-second timeouts (75.43 seconds), all timeout failures including unchanged publication cases; subsequent combined subset hit one fifteen-second repeated-Git-audit timeout (20.27 seconds). Export identity mismatches now reject before redundant Git audit; valid matching export still receives full baseline audit. Bounded logs: `/tmp/cq-boundary-g2-review-tests.log`, `/tmp/cq-boundary-g2-quota-final.log`, `/tmp/cq-boundary-g2-quota-optimized.log`. No full campaign suite rerun; prior full-suite runner timeouts remain unresolved. No model calls or actual G2 dispatch/qualification. Next runtime must be regenerated after quota/G2/native/source integrations and independently reviewed parent admission.

### Run 16 retained evidence and prospective synthetic lifecycle

Run 16 launched a thread/turn and produced nine completed item events without a completed turn or reported usage counters. Usage remains unknown. Persisted native evidence says budget and process-tree-stop-unproven; retained reports contain no supervisor lifecycle artifact that separates host-client stop, S5 termination, export, or publication failure. Assignment expiry is not established. Current namespace absence is recovery evidence only and cannot repair that missing contemporaneous proof. All real-run task/context/auth/events recovery remains private and intact.

The recovered candidate has one uncommitted task edit and unchanged HEAD. Protected mechanical judgement used the exact recovered task bytes. Distinct full inventories were reconciled to Git index cached timestamps/inodes only: volume f1f969724bd6d9817b8025ce2a171c443b8289e0b6b3dcc0c00786f9a0622396 versus refreshed host 95b353400f65a6adc3c4512c4267c67826a9d5cae95c7b0326ad4248ef8ac0e0. Tracked object identities and task file bytes/modes match; both manifests are preserved. Missing required commit still fails full task completion.

`probe-final-lifecycle.mjs CHECKOUT_ROOT` is a no-model synthetic operator. It uses the pinned nonprivileged worker image with network none, a fresh synthetic task volume, no auth/broker/host mounts, and current native runSupervised's final-profile-G1 lifecycle. A namespace child plus partial tracked/untracked writes survive killing the Docker exec client until awaited namespace teardown. The test requires native timeout, host process-tree stop, real container removal, stopped export, rollback-safe publication into the exact fixture workspace, matching inventory and preserved executable mode. It removes only its accepted synthetic volumes; private fixture publication backups remain. This synthetic adapter never admits Codex or qualifies an actual route.

Against integration 161b3c2c70078365681ce1838a1342eb41b697e7, corrected probe passed every lifecycle/publication flag; evidence is `runner/boundary/evidence/fallback/synthetic-final-lifecycle.json`. An earlier synthetic reporter accidentally read the native stop flag under an incorrect property name and exited unsuccessfully despite successful underlying termination/publication; the corrected reporter was rerun. Three existing stop-error/export-error/cleanup-error focused tests passed (44 skipped, 890ms), and probe lint passed. No full suite/model calls; no production boundary defect is established by these checks. Native's new lifecycle artifact is prospective; another G1 requires new clean source pins, parent admission and unknown-usage accounting for run 16. Whole-assignment lifetime remains unsupported for a frozen lane; G2 remains pending.

### Run 17 recovery and prospective phase diagnostics

Run 17's persisted supervisor artifact establishes timeout, unproven boundary termination/export, absent export receipt and assignment deadline not crossed. It omits the underlying lifecycle error and per-phase results, so retained evidence cannot distinguish timer/memoized termination from namespace stop, disposal, export or publication failure. No retrospective proof or behavioral fix is justified. A source-level hypothesis is concurrent cleanup: native's model timeout aborts its setup signal, whose retained runtime abort listener starts cleanup while the adapter terminates. This is a possible race, not an attributed run-17 cause; local reproduction/phase evidence is needed before another paid route.

Live pinned-daemon checks proved worker absence and exclusive task-volume ownership. Nonprivileged read-only/no-network recovery preserved all original task/context/auth/events and copied only the stopped task into a fresh private stage. Inventory 4617612713f74fec94dbc01577704143caa6542a0108324ccb9b8e7eaef1fa08 matched the recovered tree: 60 entries, 36 files, no symlinks. Baseline verified, HEAD unchanged, one modified module and no added/deleted files. Its module SHA 5ccc1b590d4f09ee3b60c721a933980b2946588e6c74e2323154adfdf1a7da60 matches run 16's partial repair. Namespace absence remains recovery-only; capture/publication and full-task completion are unproven. Reported usage input 61898/output 635/cache-read 19456, total unknown; no compatibility zeros or inferred total.

Prospective diagnostics only: `lifecycle-evidence.ts` appends to an existing parent-owned mode-0600 plain private file with O_NOFOLLOW, bounded size, no arbitrary messages, args, output or credentials. Records include fixed phases, timestamps, whitelisted error class/errno and recognized bounded-Docker operation/exit metadata. Runtime stages `boundary-lifecycle.jsonl` outside task/context and returns `lifecycleEvidencePath` through the native setup spread; final adapter records timer/close/error trigger, termination start/reuse/error, session stop, prepared disposal, stopped export, publication, cleanup and control close. Runtime abort/cleanup records permit distinguishing concurrent actors. Recorder failures never replace the original lifecycle failure; missing evidence grants no proof. Termination, cleanup and admission behavior are unchanged. Old runtimes are retired; source pins and private modules must be regenerated after integration and parent clean-HEAD notice.

Validation: six focused lifecycle/privacy/quota tests passed, 43 skipped, 656ms; typecheck and owned lint passed. Regression proves timer failure is memoized, finalization rethrows the first cause without export, secret-like messages are absent and symlink evidence redirection is refused. One initial regression over-specified asynchronous reuse/error record ordering; corrected assertions retain the causal ordering while allowing reuse before the settled error. No full suite, auth refresh, model call, cleanup deletion, host candidate execution or runtime regeneration. Both runs' recovery remains private and preserved. Another actual G1 remains blocked on actual failure diagnosis; G2/frozen-lifetime eligibility is not claimed.

### Actual runtime setup-signal ownership reproduction (2026-09-29)

The retained setup signal in `createPreparedFinalG1Runtime` could independently
start runtime cleanup after a successful handoff. A bounded synthetic reproduction
uses that actual factory, real `stageTaskClone`, `containerTaskSession`,
`finalContainerLifecycle`, pinned worker/utility images and fresh exclusive
volumes. The worker is nonprivileged, user 1000, read-only root, network `none`,
0.5 CPU / 256 MiB / 32 PIDs, with only its synthetic task volume mounted.
The child is an EventEmitter fixture; broker declarations and the auth validator
are explicitly mocked. Context files contain inert synthetic text, no auth.
This is lifecycle evidence, not subscription/runtime/G2 qualification.

The forced, feasible order was: factory handoff → adapter timer → adapter observes
worker in `ps` → retained setup signal abort → runtime cleanup observes/removes
worker → adapter `inspect` fails → memoized termination error prevents export.
Default explicit cleanup retained task/context recovery. Pre-fix proof:
`/tmp/cq-factory-abort-repro.log`, private fixture
`/Users/ctaylor/.tmp/cq-s5-factory-abort-pD677p/proof.json`.
The no-abort control completed termination/export and retained recovery:
`/tmp/cq-factory-abort-control.log`.

The narrow fix limits the abort listener to preparation and detaches it in
`finally`. It also removes the independent post-handoff cleanup timer: neither
setup cancellation nor that timer may race the active adapter. Native owns
post-handoff terminate → finalize (including failed finalization) → awaited
`cleanupInvocation`; before handoff, preparation failure awaits cleanup.
Approval refusal still awaits cleanup before any launch. Default cleanup retains
handed-off task/context/auth recovery. The fixed forced-abort ordering completed
termination/export and only then performed explicit invocation cleanup:
`/tmp/cq-factory-abort-final.log`. This proves a possible mechanism; runs 16/17
lack the original phase evidence needed to attribute their failures to it.
There is no global resource-lifetime or frozen-lane claim.

Runnable regression: `CQ_BOUNDARY_SYNTHETIC_DAEMON=1 npx vitest run
 test/boundary-campaign.test.ts -t 'actual private factory abort ownership'`.
It covers forced post-handoff abort, no-abort control, and abort immediately after
real staging but before handoff (cleanup awaited before rejection). Each case has
an explicit 90-second subprocess bound. No model, endpoint, subscription auth,
quota or existing recovery is used. Fresh synthetic recovery is retained for audit.

### Run 17 read-only judged-candidate binding

`reconcile-retained-index.mjs` checked exact daemon, task-volume label/content
ownership, worker absence before/after a nonprivileged read-only utility, then
compared that inventory with the judged host snapshot without running Git or
candidate code. Both full inventories remain distinct and preserved:
retained `4617612713f74fec94dbc01577704143caa6542a0108324ccb9b8e7eaef1fa08`,
host `04d382251a2c37bfff285c716e09253c66755b835d8b73892296cbbec948278d`.
Only `.git/index` differs. Its SHA-256 changed from
`2df779c5efef2920ae79cbc7e1b47cadc713397e52d14c8a3521d886cc4f243d`
to `532f798aedc44153ad8b61b83f94a0306da99c21d02af1fe197542511e8c59c7`.
Validated Git index v2 entries for `package.json`, `settings/display.js`, and
`test/public-settings.test.mjs` differ only ctime/mtime/inode cache fields.
Object IDs, flags, modes and extensions match; all four task-file bytes/modes
match, including module SHA-256
`5ccc1b590d4f09ee3b60c721a933980b2946588e6c74e2323154adfdf1a7da60`.
Protected judgement artifact SHA-256 is
`7e8506aa21e56305c8bac6c0a23833903f4836c64dee475d1a1971b6f8c5e353`.
Private full manifests and canonical sanitized receipt are in run17's
`index-reconciliation/`; public hashes/status log:
`/tmp/cq-boundary-reconcile17-final.log`. Existing recovery/auth/events were not
altered. Mechanical judgement binding holds; missing commit/full-task failure,
publication failure and unproven supervisor stop remain unchanged.

Final bounded regression also validates the actual stopped-export publication
receipt through `publishStoppedTask`, not merely export existence. The first
publication test fixture used an invalid export-directory name and was correctly
refused; correcting the fixture to a fresh `.cq-stopped-export-*` sibling required
no production policy relaxation. Final results: **3 passed / 49 skipped**, 12.91s;
`/tmp/cq-factory-abort-publication-final.log`. Owned ESLint, typecheck and
`git diff --check` passed. Sanitized before/after ordering artifact:
`runner/boundary/evidence/fallback/runtime-abort-synthetic.json`.
The full suite was not rerun; historical full-suite timeouts remain unchanged.

### Post-publication recovery retention (run18 follow-up)

The final-profile adapter now closes its private Docker control without deleting
staged task/context volumes. Boundary publication precedes native receipt validation;
it does not authorize recovery disposal. Explicit runtime cleanup verifies both
volumes' staging labels and absence of attached containers before reporting
`stopped-and-reaped` with `volumeDisposition: quarantined`. Missing retained volumes
fail closed and record `recoveryRetained: false`; a successful publication alone
never makes that state true. Invocation cleanup is memoized, including failures.

After handoff, `cleanup({removeRecovery:true, dispositionReceiptPath})` additionally
requires a parent-owned private 0600 JSON disposition receipt containing `approved:
true`, exact `runId`, `taskVolume`, `contextVolume`, `stagingReceiptHash`, and a
64-hex `candidateAuditSha256`. The parent must independently verify and pin its
candidate audit before issuing this disposal receipt. Runtime cleanup does not
remove publication backups, candidate exports, or event records. No disposition
receipt has been issued by this lane for runs16–18.

Runnable no-auth/no-model regression:
`CQ_BOUNDARY_SYNTHETIC_DAEMON=1 npx vitest run test/boundary-campaign.test.ts -t 'actual factory native recovery retention'`.
The companion `runner/boundary/probe-recovery-retention.mjs` uses the actual private
preparer, dedicated pinned nonprivileged network-none worker, session and native
supervisor from the trusted sibling integration checkout. Broker/auth declarations
and the child are synthetic. Cases cover accepted publication, rejected baseline,
and rejected export; after host workspace disposal each independently exports the
retained stopped volume and checks repaired file bytes. They verify namespace
absence, closed control, memoized quarantine proof and refusal of unaudited disposal.
No model, endpoint, subscription auth, or prior recovery is used.

Run18's surviving patch, judgement and original-backup manifest hashes are pinned
in `runner/boundary/evidence/fallback/run18-retention-audit.public.json`. Its full
candidate, task/context volumes and published host workspace are unavailable.
The surviving patch and judgement do not reconstruct or qualify the full candidate.
The original async baseline error was not persisted in its lifecycle artifact;
the source timing defect is separately reproducible, not retroactive stop/export
proof. Resource lifetime remains unsupported beyond the bounded decision/cleanup
contract. G2 remains pending.

### Canonical G2 evidence preservation (2026-09-29)

Boundary normalization now independently requires `toolPhase` complete with exact
positive result/pair cardinality, empty mandatory `decoderFailures`, and every
trace event's trusted `collectorSequence` and `at`. Sequences must strictly
increase in supplied collector order (gaps allowed); times cannot decrease.
Unique event IDs, matched correlation IDs, invocation identity, phase order,
kind and exact command/target are checked before any probe row is complete.
Shell starts require `in_progress` and explicit null exit; results require
`completed`/`failed`, bounded integer exit, `aggregated_output` source and actual
output bytes. Successful/denied outcomes must match their raw exit and status.
Omitted fields, unavailable decoding, invalid JSON failure codes, reordered
frames or invalid status cannot be erased by a canonical converter.

The additive contract is coordinated with native ownership of the decoder and
converter. Overall invocation timeout/cancellation remains independent of
completed tool items. Ledger admission and independent stopped-export bindings
remain required; this validation does not grant qualification. Unobserved
read/search/http/config channels remain unobserved.

Typed denial annotations alone are insufficient. The optional trusted
`G2ControlVerifier.verifyDenialEvidence({probe,event})` seam must check an
independent private instrumentation source receipt bound to invocation/item,
probe identity, exact command/target, observed errno/HTTP/exit/control status,
collector sequence/time and source digest. It must verify independently owned
observation provenance, not echo `verified:true` or model output. No production
instrumentation producer is claimed available; absent/negative verification
makes denials unavailable. Synthetic positive verification only tests this seam.
No models, credentials, quota, namespaces or preserved recovery were accessed.
