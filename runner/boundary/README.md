# CQ campaign boundary contract

`compileBoundary(spec)` resolves every explicit path, rejects grants overlapping
protected material and emits a default-deny SBPL profile plus a SHA-256 identity.
Create fresh, disjoint `task/`, `context/`, `home/`, `tmp/` under a dedicated bundle.
Stage only declared task context, dependencies and minimal native configuration.
Declare judge, solutions, sibling held-outs, research, fixtures, campaign archives
and ambient config in `forbidden`. Never materialize hidden data in the bundle.
Keep context and toolchain immutable on the host while a worker is running.

Toolchain trees must be narrow, justified runtime distributions. Authentication
allows exact existing files only; preferably stage minimal subscription auth in
context. A staged file is accessible to the worker: sandboxing does not sanitize
its contents. Native owners must remove connectors/MCP/extensions and unwanted
ambient instructions from staged configuration and pin/hash those artifacts.
No real authentication was copied/read in this implementation's probes.

System reads are limited to `/System/Library`, `/usr/lib`, dyld state, runtime
random/null devices, `/private/var/select/sh`, and literal `/`. Darwin dyld aborts
without opening the root directory; that literal grant permits listing root
names but **does not permit reading root descendants**. Literal parent metadata
permits path resolution, not parent directory enumeration. `/bin/sh` invokes the
selected `/bin/bash` here: declare both binaries when using that shell. Arbitrary
executable children are denied; interpreter-based tools still inherit read rules.

## Process isolation finding and held-out blocker

A local C probe can read another same-user process's **seeded synthetic** argv/env
using Darwin `sysctl(KERN_PROCARGS2)`. Exploratory literal/regex and blanket sysctl denial attempts did not establish
verified process isolation. A small sysctl allowlist also broke Node startup. The compatible policy retains sysctl runtime
access and declares `heldOutEligible: false`. No real process credentials were
read or printed in that probe. The regression test checks the exact synthetic
sentinel and the wrapper's refusal of held-out launches; a passing test records
this limitation, not successful process isolation.

File unreadability is therefore **not complete host isolation**. Require a
validated separate process identity/namespace or container/VM before held-out
admission. Do not put judge/solution/sibling/ambient secrets in same-user argv/env
and assume the filesystem allowlist protects them. Actual-route G2 remains
blocked, and this wrapper deliberately has no held-out override.

## Network and extension controls

This Darwin SBPL implementation accepts only `localhost` or `*` as remote hosts.
External IP literals fail profile compilation. This implementation refuses `*` and
supports exact `localhost:port` endpoints (IPv4 and IPv6 loopback). All remaining
network access, inbound listeners, host sockets and Mach service lookup stay
denied. No implicit DNS, HTTP, provider-network or full-home exception exists.

To run an external model route, supply a separately verified trusted loopback
broker/service with upstream endpoint ACLs and no host-filesystem/connector/tool
interface. Capture its upstream restrictions in the `networkEvidence` artifact;
the reference and local port become part of boundary identity. Proxy environment
keys may be explicitly bound. A broker is **not implemented or validated here**.
TLS/hostname/redirect checks, proxy support in the native runtime, and direct
network denial need actual-route tests. A VM/container with equivalent network
restrictions is an alternative, not an automatic fallback.

`extensions.mode` is currently `disabled` only. `launchEvidence` is the native
owner's evidence reference for verified disabling flags and sanitized effective
config. `nativeControlsAttested` means that reference was supplied, not that this
policy compiler inspected a native runtime or established G2. Read protection
alone cannot prevent an allowed interpreter from treating task code as an
extension. Native auto-loading controls must therefore be independently verified.

## Spawn seam for the sibling native worker

Import `spawnBoundary` in the native process supervisor (not the public toolkit
Driver). Pass a compiled policy, resolved executable, argv, purpose and optionally
an exact `bindingNames`/`bindings` map. Loader/shell override variables and implicit
ambient environment inheritance are refused. HOME/XDG/TMPDIR/PATH point at the
bundle and declared executable directories. The wrapper uses task cwd, three
pipes and a detached process group; shell children inherit the sandbox.

For `purpose: 'actual-route'`, provide the native-control evidence reference,
network-control evidence when using endpoints, and `heldOut: false` (visible calibration or isolation development only), and an `admit(boundaryIdentity)`
callback returning a nonempty orchestrator admission ID. Admission must enforce
fresh quota telemetry, GLM blackout, bounded workboard/budget and assignment
eligibility. A true held-out flag is refused; an omitted actual-route scope is also refused. The wrapper re-resolves policy roots before and after admission and
never retries without the sandbox. `purpose: 'no-model-probe'` refuses endpoint,
auth-file and environment-binding grants. There is no automatic model call.

Return values: `child`, `boundaryIdentity`, `launchIdentity`, `admissionId`,
`environmentNames`. The launch hash binds executable, argv and environment **key
names** to the policy. Native ownership remains stdin/protocol handling, raw event
capture/redaction, timeout/cancellation/process-group cleanup, envelope persistence
and workspace/patch capture in finally. Integrate this seam in `runSupervised` or
an injected spawner and retain existing supervision; do not wrap only one tool or
replace transport supervision with the probe helpers. Handle child `error` events.

Bind boundary/launch identity, executable hash/version, source pins, staged
context/config/dependency hashes, effective native settings and broker evidence
into the canonical strategy/experiment identity. Dedicated absolute paths are
included in the boundary hash, so rematerializing a bundle produces a new physical
boundary instance; strategy recipes should also retain their stable logical
inventory and explicitly bind each physical instance. Environment values and raw
argv/config may contain credentials and require private storage/redaction.

## Evidence and G2

`probeHostBoundary()` creates synthetic hidden sentinels and probes direct Node
reads, shell/Node children, symlinks, module loading, ambient config, authorized
reads/writes, context write denial and default network denial. It emits booleans
and policies, never sentinel contents or credential values. The synthetic module
loader can report MODULE_NOT_FOUND because metadata is denied; the same existing
file is also independently proven unreadable with EPERM/EACCES. Probes have a
30-second process-group bound and never establish G2.

`probeNativeVersion()` runs only `--version`, no auth, no network, clean dedicated
home; its 15-second bound and numeric-only retained output cannot prove model,
subscription or native-tool conformance. `discoverFallbacks()` performs bounded
read-only Docker/Colima/Lima discovery. Presence/CLI success is not confinement.

The native owner must produce actual-route sentinel attempts through direct
filesystem, shell, symlink/absolute path, native read/edit/search tools, MCP or
extension entry paths and ambient context discovery. Prove authorized task and
minimal subscription auth access still works, native tools actually execute,
undeclared extensions/services fail and broker endpoint ACLs hold. Store raw
private events, safe outcome evidence, policy/allowlist/hashes and exact invocation
IDs for every final native/diagnostic boundary. Shell/version/local-socket probes
are preliminary only. G2 also needs the orchestrator's frozen evaluation design;
no held-out claim is permitted until both parts are verified.
