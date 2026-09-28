Read-only independent local reviewer: fallback_review. No external review service,
credential reads, model calls, VM mutation or source edits by reviewer.

Initial findings: labels without live content; broker IP without image/config identity;
ambient Docker client config; export before child teardown; omitted heldOut accepted;
partial ACL matching; teardown without absence read-back.
Narrow fixes: required full private staging receipt and live inventory/exclusive mounts;
fixed broker image/container/config identity; empty per-control Docker config and pull
never; teardown-first task session; explicit heldOut false; complete canonical IPv4/
IPv6 filter comparison; idempotent teardown with absence read-back.

Follow-up found mutable captured receipt/broker inputs and special mode masking.
Inputs are now structured-cloned at adapter construction; utility read rejects 07000
bits. Reviewer confirmed ordering, /task-only inspection, link-chain validation,
baseline ancestry and empty-destination materialization. Actual route remains gated.

Limits: trusted dedicated daemon administrator may mutate private resources; this
is not an adversarial-admin boundary. Native transport lifecycle callbacks and
production broker authentication remain outside this ownership and unqualified.
