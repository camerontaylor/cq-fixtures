# Native Codex shell-event decoder

This is an offline decoder seam, not a G2 runner or qualification. It performs
no Codex dispatch, reads no credentials, and does not inspect or execute a
candidate.

## Callable API

`decodeCodexShellEventFrames({ invocationId, frames })` in
`codex-g2-events.ts` accepts parsed Codex JSON events (or exact JSONL event
lines) paired with the trusted native collector's `collectorSequence` and
`collectedAt`. Sequence gaps are allowed; supplied event order must have unique
increasing sequence values and nondecreasing collector times. The decoder
returns `toolPhase`, `decoderFailures`, correlated native `toolTrace`, and
per-channel coverage. It never invents a sequence, timestamp, status, exit
code, HTTP status, or control proof.

The decoder accepts Codex `item.started` and `item.completed` events whose
`item.type === "command_execution"`. It correlates the exact item ID and
command, preserves frames in collector order, and requires one start and one
result. Start status must be `in_progress` with a null exit code. Result status
must be `completed` or `failed` with an integer exit code. The result retains
raw status, exit code, sequence, time, and `aggregated_output` bytes. Output is
private; it is not copied into normalized public events. Codex combines the
command streams, so the adapter carries those opaque bytes in the boundary
output buffer slot without claiming a separate stdout/stderr split.

`toBoundaryCanonicalNativeReceipt(receipt, fixture?, controlVerifier?)` rejects
an unavailable phase, decoder failures, bad cardinality, duplicate or
unmatched events, invalid collector order/time, malformed shell status, and
unverified denials. It retains `toolPhase`, `decoderFailures`, each event's
`collectorSequence` and `at`, raw shell status/exit, output source/bytes,
invocation terminal state, and proven teardown/export in the canonical
boundary shape. Invocation timeout stays independent from a completed tool
phase; no overall exit-0 requirement is applied to tool decoding.

The decoder derives shell success only from `status: completed` plus
`exit_code: 0`. Nonzero exit and output text alone never prove denial. Denial
requires `G2ControlVerifier.verifyDenialEvidence({ probe, event })` to accept
independent trusted evidence bound to the expected probe and correlated event.
No trusted control producer exists in this lane, so native decoding does not
create denied outcomes and denial probes remain unavailable until the parent
supplies that verifier. Agent prose and aggregated output never establish
denial evidence.

## Capability inventory limits

Read-only local checks observed `/usr/local/bin/codex` resolving through the
mise shim as `codex-cli 0.155.1`. `codex exec --help` documents JSONL output,
`--ignore-user-config`, explicit model/config flags and general exec controls;
it does not enumerate agent tool capabilities. `codex mcp --help` documents a
separate MCP management command, not the tools loaded into an exec invocation.
No authenticated exact-profile startup or MCP/web-search discovery was run.
Shell is observed only when a command event is present; `read`, `search`,
`http`, and `config` remain **unobserved**, not declared unsupported.

## Verification limits

Sanitized tests cover the saved command event shape, item/command correlation,
collector sequence/time, reversed equal-time frames, duplicate/unmatched/
mismatched events, invalid start status, invalid JSON, null exit, exact result
cardinality, exit/outcome mismatch, rejected canonical conversion, and denial
verifier fail-closed behavior. No live route, model, auth context, profile
configuration, quota, boundary provisioning, G2 admission, or candidate
workspace is involved. Complete shell decoding is not a G2 pass; read/search/
http/config traces, trusted denial verification, output scan, consumed
admission, stopped export and boundary checks remain required.
