# Provenance — suites/review-classifier/breadth-tail

## Authorship

LM-drafted plus one annotator (the F4 tail executor, 2026-09-21), labeled against
`../LABEL-GUIDE.md` v1.0. The thirty thread payloads were authored for this repo in
this run with deliberately low scenario overlap against `breadth-verified`; nothing
was copied from an external corpus. A 20% double-coded audit subset (bt-03, bt-08,
bt-14, bt-19, bt-25, bt-29) receives a second independent pass; audit adjudication
records land before merge.

## Contamination posture

No public-benchmark instances are included or adapted. The payloads are fictional,
recorded-SHAPE only: they imitate the GitHub review-thread shape (id, path, line,
resolved, comments with author/body/createdAt/isReply) but every repo path, handle,
and quote is invented, and no real project or person is referenced. Each payload's
content honestly matches its expected verdict so the labels are derivable from the
text, not arbitrary.

## Payload-to-verdict table

| Case | Payload | Expected verdict | Why the content matches |
| --- | --- | --- | --- |
| bt-01 | `fixtures/threads/bt-01.json` | actionable | unresolved dropped trailing debounce call, no reply |
| bt-02 | `fixtures/threads/bt-02.json` | actionable | unresolved path traversal with exploit sketch, no reply |
| bt-03 | `fixtures/threads/bt-03.json` | actionable | unresolved descriptor exhaustion on large exports, no reply |
| bt-04 | `fixtures/threads/bt-04.json` | actionable | hollow "Fixed, PTAL" with no evidence (adversarial) |
| bt-05 | `fixtures/threads/bt-05.json` | actionable | unresolved 4xx retry predicate, no reply |
| bt-06 | `fixtures/threads/bt-06.json` | actionable | "looking into it" non-answer on swapped args (adversarial) |
| bt-07 | `fixtures/threads/bt-07.json` | responded | author wired the stale flag, regression test, green run |
| bt-08 | `fixtures/threads/bt-08.json` | responded | author rewrote the backtracking pattern, bench numbers |
| bt-09 | `fixtures/threads/bt-09.json` | responded | wrong XSS claim disproved via auto-escaping + test (benign) |
| bt-10 | `fixtures/threads/bt-10.json` | responded | author added acquire timeout + gauges, load test green |
| bt-11 | `fixtures/threads/bt-11.json` | responded | wrong breaking-change claim disproved via compat test (benign) |
| bt-12 | `fixtures/threads/bt-12.json` | responded | author deduped comparators, tie-break test green |
| bt-13 | `fixtures/threads/bt-13.json` | resolved | `resolved: true` with a concluding reply |
| bt-14 | `fixtures/threads/bt-14.json` | resolved | "MEMORY LEAK" shown bounded LRU, resolved as invalid (benign) |
| bt-15 | `fixtures/threads/bt-15.json` | resolved | `resolved: true` with a concluding reply |
| bt-16 | `fixtures/threads/bt-16.json` | resolved | "CPU spin" shown bounded timer sleep, invalid (benign) |
| bt-17 | `fixtures/threads/bt-17.json` | resolved | `resolved: true` with a concluding reply |
| bt-18 | `fixtures/threads/bt-18.json` | resolved | "DATA CORRUPTION" shown display-only rounding, invalid (benign) |
| bt-19 | `fixtures/threads/bt-19.json` | blocked | explicitly waiting on the accessibility council ruling |
| bt-20 | `fixtures/threads/bt-20.json` | blocked | alarmist tone on a routine trademark sign-off gate (benign) |
| bt-21 | `fixtures/threads/bt-21.json` | blocked | status-check reply changes nothing on the vendor ticket (adversarial) |
| bt-22 | `fixtures/threads/bt-22.json` | blocked | explicitly waiting on the infra maintenance window |
| bt-23 | `fixtures/threads/bt-23.json` | blocked | alarmist unsigned-image claim on a dev scope, board wait (benign) |
| bt-24 | `fixtures/threads/bt-24.json` | blocked | question awaiting the security-team retention ruling |
| bt-25 | `fixtures/threads/bt-25.json` | skip | tabs-vs-spaces preference, explicitly optional |
| bt-26 | `fixtures/threads/bt-26.json` | skip | alarmist naming claim with explicit non-blocking (benign) |
| bt-27 | `fixtures/threads/bt-27.json` | skip | declined module-move suggestion, explicitly optional |
| bt-28 | `fixtures/threads/bt-28.json` | skip | alarmist record on a settled decision, no reopen ask (benign) |
| bt-29 | `fixtures/threads/bt-29.json` | skip | comment typo, explicitly ignorable |
| bt-30 | `fixtures/threads/bt-30.json` | skip | alarmist formatting claim retracted via formatter (benign, adversarial) |
