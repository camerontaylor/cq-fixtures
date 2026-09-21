# Provenance — suites/review-classifier/breadth-verified

## Authorship

Hand-written synthetic content produced by the F4 lane run, 2026-09-21, against the
versioned label guide `suites/review-classifier/LABEL-GUIDE.md` v1.0 (rule chain R0–R6).
First annotation pass (`executor-pass1`) recorded in each case's `label.json`; the second
independent pass plus third-pass adjudication land before merge (target κ ≥ 0.75).
Nothing was copied from an external corpus.

## Contamination posture

No public-benchmark instances are included or adapted. The payloads are fictional,
recorded-SHAPE only: they imitate the GitHub review-thread shape (id, path, line,
resolved, comments with author/body/createdAt/isReply) but every repo path, handle, and
quote is invented, and no real project or person is referenced. Each payload's content
honestly matches its expected verdict under the guide's rule chain, so the labels are
derivable from the text, not arbitrary. The 6-per-verdict balance is a design target,
not a field prior (see `suite.json` `provenance.origin`).

## Corpus composition

30 cases, 6 per verdict. 10 suspicious-but-benign (`fp_flag: suspicious-benign`,
expected ≠ actionable: alarmist tone on a preference, plausible-but-wrong claims on
correct code, resolved threads with still-scary comments). 5 adversarial-reply patterns
(replies that mimic resolution/blocking/withdrawal without delivering it).

## Payload-to-verdict table

| Case | Payload | Expected verdict | Why the content matches |
| --- | --- | --- | --- |
| bv-01 | `fixtures/threads/bv-01.json` | actionable | unresolved off-by-one with repro, no reply (R4, Logic & functionality) |
| bv-02 | `fixtures/threads/bv-02.json` | actionable | unresolved open redirect with exploit sketch, no reply (R4, Validation/Security) |
| bv-03 | `fixtures/threads/bv-03.json` | actionable | unresolved connection leak on the error path, no reply (R4, Resource) |
| bv-04 | `fixtures/threads/bv-04.json` | actionable | N+1 concern stands: author reply "Tweaked, PTAL" carries no evidence and asks re-review — not R3 (R4, Performance; adversarial) |
| bv-05 | `fixtures/threads/bv-05.json` | actionable | doc promises 429+Retry-After, code returns bare 503; unresolved disagreement (R4, API documentation) |
| bv-06 | `fixtures/threads/bv-06.json` | actionable | design question demanding a lock decision before merge; follow-up reply answers nothing (R6; adversarial) |
| bv-07 | `fixtures/threads/bv-07.json` | responded | author flipped the inverted check, added a regression test, green run cited, nothing further (R3) |
| bv-08 | `fixtures/threads/bv-08.json` | responded | author rewrote O(n²) with an index map, p95 before/after cited (R3) |
| bv-09 | `fixtures/threads/bv-09.json` | responded | wrong race alarm disproved with single-consumer evidence + test (R3; suspicious-benign) |
| bv-10 | `fixtures/threads/bv-10.json` | responded | wrong injection alarm disproved with allow-list source + escaper + clean scan (R3; suspicious-benign) |
| bv-11 | `fixtures/threads/bv-11.json` | responded | author shipped 201+Location, gateway contract test green (R3) |
| bv-12 | `fixtures/threads/bv-12.json` | responded | author added close-on-abort, 24h soak at zero dead sockets (R3) |
| bv-13 | `fixtures/threads/bv-13.json` | resolved | `resolved: true` with fix + fixture ("Resolving") (R0) |
| bv-14 | `fixtures/threads/bv-14.json` | resolved | wrong leak alarm: pool capped at 512/LRU, soak at 61% — resolved as invalid (R0; suspicious-benign) |
| bv-15 | `fixtures/threads/bv-15.json` | resolved | wrong DATA LOSS alarm: void is soft-delete under constraint, walked through with finance — resolved as invalid (R0; suspicious-benign) |
| bv-16 | `fixtures/threads/bv-16.json` | resolved | `resolved: true` with rename ("Resolving") — R0 precedes R2/R5 (R0) |
| bv-17 | `fixtures/threads/bv-17.json` | resolved | reviewer retracts own off-by-one claim after recheck — resolved as invalid (R0; suspicious-benign) |
| bv-18 | `fixtures/threads/bv-18.json` | resolved | wrong OOM alarm: batches capped at 1k events, load test at 38MB — resolved as invalid (R0; suspicious-benign) |
| bv-19 | `fixtures/threads/bv-19.json` | blocked | merge semantics parked with the platform council's unpublished policy; no code change requested (R1) |
| bv-20 | `fixtures/threads/bv-20.json` | blocked | version pin waits on the vendor's v3 cutover date; alarmist over a hypothetical, nothing broken today (R1; suspicious-benign) |
| bv-21 | `fixtures/threads/bv-21.json` | blocked | shared-index naming waits on the search council; "any update?" reply unblocks nothing (R1; adversarial) |
| bv-22 | `fixtures/threads/bv-22.json` | blocked | pool tuning waits on the vendor quota ticket; restating reply adds nothing (R1; adversarial) |
| bv-23 | `fixtures/threads/bv-23.json` | blocked | recovery bypass awaits the security review board's ruling (R1) |
| bv-24 | `fixtures/threads/bv-24.json` | blocked | release waits on legal sign-off of license text; alarmist over a routine gate (R1; suspicious-benign) |
| bv-25 | `fixtures/threads/bv-25.json` | skip | explicitly optional cosmetic nit, "feel free to ignore" (R2) |
| bv-26 | `fixtures/threads/bv-26.json` | skip | changelog note explicitly "not asking for changes here" (R2) |
| bv-27 | `fixtures/threads/bv-27.json` | skip | alarmist preference retracted by its own author ("misread — ignore"); Naming, no policy flag (R5; suspicious-benign; adversarial) |
| bv-28 | `fixtures/threads/bv-28.json` | skip | pure praise, no notes (R6) |
| bv-29 | `fixtures/threads/bv-29.json` | skip | alarmist preference framed as non-blocking nit (R2; suspicious-benign) |
| bv-30 | `fixtures/threads/bv-30.json` | skip | curiosity question demanding no change (R6) |
