# Parent private final-container G1 runtime

No model dispatch is performed by either preparation script or runtime verification. Parent approval is absent by default.

After integrating this boundary commit and native G1 entrypoint into the exact parent tree, prepare with:

```
node runner/boundary/prepare-final-g1-runtime.mjs /absolute/parent/repo parent-chosen-unique-run-id
```

This creates a private0600 runtime module and disabled parent approval template under a canonical private0700 directory, an exclusively labelled internal network and read-only nonprivileged broker on the existing bounded dedicated VM. All images are immutable. No host configuration/context changes, host mounts, shared-token refresh, app-server quota subprocess or model turn occur. Auth is freshly read from the exact existing subscription file, staged as access-only tokens without refresh authority, and inventoried privately. Only auth.json and frozen config.toml enter the worker context. Infrastructure verification checks daemon, VM config, worker/broker/utility image IDs, live broker route identity, exact subnet/attachments, native config hash, reviewed source pins and expiry.

The parent reviews the **public nonsecret template**, runtime factory and source/assignment pins, then creates `parent-approval.json` with0600 permissions next to the private module, setting approved=true, a unique admission ID and an expiry within15minutes. The parent approval specifically authorizes independently verified dynamic private task/context staging. The runtime never derives approval by echoing the native callback: it validates all four intended task files against independently materialized reviewed corpus source, excludes extra non-Git files/symlinks, audits the pristine baseline, stages exact runSuite cwd, independently compiles its own specification and derives invocation identity from reviewed final arguments/bootstrap/90second budget. Those expected private identities are frozen **before** approve is called; callback differences are rejected. They remain private because boundary identity incorporates sensitive credential-derived inventory. Native subsequently freezes/consumes the authoritative exclusive replay ledger.

Only after separate parent final-profile-G1 admission:

```
node --experimental-strip-types runner/native/run-final-profile-g1.ts /private/generated/runtime.mjs
```

Cleanup (no model dispatch), including after setup timeout/failure:

```
node --input-type=module -e 'const m=await import(process.argv[1]); console.log(await m.cleanupFinalProfileG1Runtime())' file:///private/generated/runtime.mjs
```

Default cleanup tears down exact owned worker namespaces, broker and network; after runtime handoff it retains task/context volumes and auth inventory for native export/recovery. Before handoff it removes exclusively labelled staging volumes and private auth. After parent accepts successful export or explicitly abandons recovery, call cleanup with `{removeRecovery:true}` to remove remaining owned volumes/auth. All cleanup rechecks daemon, labels and exclusive attachments and works without requiring live infrastructure or unexpired auth. Publication original backups/manifests are retained privately alongside the assigned workspace for independent parent disposition; do not sweep siblings.

Unsupported lifetime label: Docker staging operations are bounded individually but are not interruptible by this runtime. The runtime enforces an earlier absolute setup cutoff (55seconds after assignment start, maximum45seconds locally), refuses late results and self-cleans once staging settles. A deadline lease and context abort stop owned infrastructure after handoff; native must still propagate factory/setup failure cancellation promptly and await all teardown/export hooks. Missing native propagation remains an explicit prerequisite, not a claim of prompt cancellation.

Publication uses an empty same-filesystem sibling export only after namespace absence, safe traversal and baseline checks. It binds exact canonical assigned workspace and parent ownership; rejects symlink ancestors, aliases, changed pristine host inventory/baseline and changed export hash/HEAD. Two rename steps retain a private original backup; a failed candidate rename restores that original when possible and always retains complete recovery trees and a0600 hashed manifest. It never executes candidate code on host. Separate S1 capture metadata outside the workspace is untouched; the ordinary worker .git is exported intact. Whole-workflow G2 still requires protected oracle integration and actual native traces under a distinct admission.
