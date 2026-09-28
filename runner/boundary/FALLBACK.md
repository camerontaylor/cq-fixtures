# Dedicated VM/container candidate

This follow-up resolves VM availability and qualifies synthetic namespace/egress
controls. G2, subscription auth, native tools/extensions and actual routes remain
unverified. The host sysctl blocker is unchanged. Both spawn seams still refuse
held-out launches; there is no synthetic-evidence override.

## Resources

Dedicated Colima profile `cq-boundary-s5` runs VZ / Linux x86_64 with 2 CPUs,
3 GiB RAM, an 8 GiB root disk and 12 GiB data disk. Initial startup: 132.53s.
Lima config has no host mounts, agent forwarding or public port forwarding.
Administration sockets are forwarded only to the trusted host supervisor and
never mounted in workers. Existing default remains stopped; global Docker
context is unchanged. The dedicated VM is left running for parent/native work.
Stop only this profile with `colima stop cq-boundary-s5` when no longer needed.

Synthetic containers, named volumes, networks, host helpers and hidden files are
removed by the probe runner; local images remain in this dedicated daemon.
No registry push, public listener, real auth copy or model call occurred.

## Reproduce

Exact startup command, times and resources: `evidence/fallback/provision.json`,
`vm-config.json`, `resource-status.json`, `container-probes.json`.
Run `python3 runner/boundary/fallback-probe.py` for bounded synthetic-only image
builds and real filesystem/process/TLS/egress probes. It refuses pre-existing
named objects instead of replacing them. Docker operations have 30s bounds,
builds 90s, probes 40s, live adapter 90s. No polling loop or full-suite run.

Run `python3 runner/boundary/runtime-image-probe.py` for exact Linux runtime
provisioning followed by offline startup. Base image is pinned by digest.
Codex 0.155.1 and ZCode ACP server 0.37.3 install from the registry. Installed
Pi `0.0.0-overshrim` is unpublished; only its explicit bundle/package and Chord
dist/package subset (152 hashed files) is copied. Linux versions/help work with
`--network none`, fresh home and no auth. ZCode help is not an ACP-session proof.
`linux-runtime-startup.json` retains the local native image content ID; no selected
CQ toolkit repacking or replacement occurs. Trusted package provisioning has
download access but no task, hidden data or credentials.

## Enforcement and identity

UID/GID 1000 workers use read-only root, dropped capabilities, no-new-privileges,
default Docker seccomp/AppArmor, private PID/IPC/cgroup/network namespaces and
bounded CPU/memory/PIDs. Only local VM named volumes `/task` writable and
`/context` read-only are accepted. Local driver bind/device/NFS options are refused.
Home/tmp are fresh bounded tmpfs. Toolchain is a content-pinned Linux image.
Minimal exact native auth files may later be staged in context by native owner;
there is no host-home/research/fixture/hidden mount grant.

Trusted supervisor runs `namespace-acl.sh` via VM sudo/nsenter into a harmless
fresh Node gate's namespace, never the VM host namespace. IPv4/IPv6 input/output/
forward default DROP; only TCP to the exact broker IP/port and established replies
are allowed. No DNS, loopback, Docker DNS, VM gateway or public-egress exception.
Read back filter rules before native/task code. Workers lack firewall capabilities.
The initial adapter correctly refused ambiguous NAT/filter combined read-back;
retained rejection evidence is historical. Final adapter reads only filter tables.

`egress-broker.ts` accepts reverse routes `/route/<id>/<path>` with exact TLS
hostname/SNI, pinned IPv4 inventory, allowed path prefix, methods and headers.
It verifies certificates, rejects CONNECT, absolute URLs, upgrade, ambiguous
paths and **all** redirects, and bounds request bytes/time. Worker inputs cannot
choose upstream host, DNS, Host or SNI. It logs no URL/body/header/credential data.
Synthetic CA/private destinations set `productionEligible:false`, which blocks
actual-route admission. Production IP inventory must be public IPv4. Operator
DNS resolution is frozen into the broker policy; any IP/TLS/route change changes
identity. TLS mismatch and redirect failure are tested through actual HTTPS.

Production broker needs a separate egress network plus worker internal network,
and supervisor-installed upstream ACLs for its pinned IPs. Worker network ACL
permits only the broker; the broker is a reverse HTTPS client, never a router or
arbitrary tunnel. No real provider broker is configured. Native reverse-base-URL
and subscription compatibility are unverified; HTTPS_PROXY/CONNECT support is
not assumed. Incompatible runtimes require another enforceable TLS endpoint
strategy before admission, not a broad internet exception.

`compileContainerBoundary` binds daemon ID, VM-config hash, image content pin,
volumes/staging receipt, exact auth-file inventory, native-control evidence and
broker/network/namespace inventory. `containerPreparer(spec)` checks live VM/
daemon/image, safe labeled volumes and internal /24 with broker attachment,
creates/verifies a fresh gate container, installs/read-backs ACLs and returns
specific container ID, identity, ACL hash and `dispose`. Image loader/credential
environment is refused. Retain `namespace-acl.sh` beside any compiled preparation
module; source Node TS works directly. Staging volume labels must match
`cq.boundary.staging=<receipt>` and `cq.boundary.kind=task|context`. These labels
reference the trusted owner's private content inventory, not a content audit.

## Native contract and admission

Use `spawnContainerBoundary` with `prepare:containerPreparer(spec)` in the existing
native supervisor. Actual routes require native-control evidence, production
broker, `heldOut:false` and parent admission. Probe purpose refuses staged auth
and production broker. Returned Docker exec pipes retain native stdin/protocol/
event/timeout ownership. Supplied evidence references are attestations, not G2.

**Killing the Docker client does not kill exec descendants.** Native owner must
call returned `dispose()` on timeout/cancel/error/finally to remove the dedicated
container and all children. Capture events and task patch/workspace first.
Task volume survives removal for trusted bounded export to the runner's assigned
workspace. Export only `/task`; do not grade the probe image's synthetic seed.
Auth/config are explicit staged context files, never inherited host environment.

Next steps:

1. Native/task owner pins final Linux image and stages only visible assigned task,
   context/dependencies and exact minimal subscription auth/config. Hash inventory;
   disable connectors/MCP/auto-extensions and verify keychain/auth portability.
2. Establish native G1 on the selected toolkit's visible task with real route,
   model/effort/tools/permission/session/profile fidelity. Retain real absent routes.
3. Derive exact provider and auth-refresh hosts/paths from native configuration,
   configure production broker and prove subscription equality through base URL.
   Pin broker image/config/DNS/TLS/upstream ACLs; never switch silently to API keys.
4. Parent grants fresh quota/blackout/budget/assignment admission. Integrate exec
   transport plus mandatory container cleanup/patch capture before paid probes.
5. Collect actual native tool/shell/symlink/config/extension/MCP and unauthorized
   endpoint/process sentinel outcomes in the final physical runtime. Retain private
   events and safe invocation/hash evidence. Parent combines frozen design and
   route evidence for G2; successful shell/startup probes alone cannot establish it.

The historical host `g2-blockers.json` is unchanged. The remaining fallback
blocker is native-route/auth/profile conformance, rather than missing VM runtime.
