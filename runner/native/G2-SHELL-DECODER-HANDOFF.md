# Native Codex shell-event decoder

This is an offline decoder seam, not a G2 runner or qualification. It performs
no Codex dispatch, reads no credentials, and does not inspect or execute a
candidate.

## Callable API

`decodeCodexShellEventFrames({ invocationId, frames, controls? })` in
`codex-g2-events.ts` accepts parsed Codex JSON events (or exact JSONL event
lines) paired with the trusted native collector's `collectedAt` timestamp. It
returns `toolPhase`, correlated native `toolTrace`, per-channel coverage and
sanitized failure codes. It never invents a timestamp, command status, exit
code, HTTP status or control proof.

The decoder accepts Codex `item.started` and `item.completed` events whose
`item.type` is `command_execution`. It correlates on the exact item `id`,
requires the exact command to match, checks collector order and pairs one start
with one completed item. The result retains actual `status`, `exit_code`
(including `null`), collector times, and `aggregated_output` bytes. Output is
private; it is not copied into the normalized public event. The boundary
canonical adapter places those opaque bytes in its output buffer slot because
Codex reports aggregated output and does not identify separate stdout/stderr.

`toBoundaryCanonicalNativeReceipt(receipt)` copies the native receipt into the
field structure in `runner/boundary/g2-harness.ts`: identity, launch, overall
terminal state, correlated tool events, optional output buffers and proven
teardown/export. The result outcome uses the exact boundary fields:
`disposition`, `denialKind`, `exitCode`, `httpStatus`, `toolErrorCode`, and
`controlProof`. `toolStatus`/nullable raw `toolExitCode` remain native private
event evidence. The boundary then applies its stricter per-probe denial and
output-scan rules.

Command completion is independent of the overall Codex invocation terminal.
A command can have a correlated successful `completed`/exit-0 result before the
invocation later times out. The receipt preserves `terminal.state: timeout`,
the tool result, and separately proven teardown. Missing command completion,
null exit code, duplicate IDs, command mismatch, invalid collector timestamps,
or reordered frames make the tool phase unavailable. Overall timeout does not
rewrite a completed command event or become an exit-0 invocation.

The decoder derives shell success only from `status: completed` plus
`exit_code: 0`. Nonzero exit and output text alone never prove denial. A denied
result requires a matching invocation/item control annotation with an allowed
native errno (`EACCES`, `EPERM`, `ENOENT`) or verified namespace control proof.
No agent prose or `aggregated_output` text creates denial evidence.

## Capability inventory limits

Read-only local checks observed `/usr/local/bin/codex` resolving through the
mise shim as `codex-cli 0.155.1`. `codex exec --help` documents JSONL output,
`--ignore-user-config`, explicit model/config flags and general exec controls;
it does not enumerate agent tool capabilities. `codex mcp --help` documents a
separate MCP management command, not the tools loaded into an exec invocation.
The final profile uses `--ignore-user-config`; no authenticated exact-profile
startup or MCP/web-search discovery was run in this no-dispatch task. Therefore
the decoder reports shell as observed only when a command event is present,
and `read`, `search`, `http`, and `config` as **unobserved**. It makes no claim
that optional MCP/web-search or native tools are unsupported. Shell events do
not substitute for those channels.

## Offline verification and limits

Sanitized tests cover the recorded `command_execution` field shape, item-ID and
command correlation, trusted collector times, reorder/duplicate/unmatched
failure, null exit, and denial control corroboration. No live route, model,
auth context, profile configuration, quota, boundary provisioning, G2
admission, or candidate workspace is involved. A complete decoded shell tool
phase is not a G2 pass: actual read/search/http/config traces, typed controls,
guardian evidence, output scan, consumed admission, stopped export and the
boundary runner's independent checks remain required.
