# Provenance — suites/review-classifier/micro

## Authorship

Hand-written synthetic content produced by the phase-3 lane-J run, 2026-09-16. The ten thread
payloads were authored for this repo in this run; nothing was copied from an external corpus.

## Contamination posture

No public-benchmark instances are included or adapted. The payloads are fictional,
recorded-SHAPE only: they imitate the GitHub review-thread shape (id, path, line, resolved,
comments with author/body/createdAt/isReply) but every repo path, handle, and quote is invented,
and no real project or person is referenced. Each payload's content honestly matches its
expected verdict so the labels are derivable from the text, not arbitrary.

## Payload-to-verdict table

| Case | Payload | Expected verdict | Why the content matches |
| --- | --- | --- | --- |
| thread-01 | `fixtures/threads/thread-01.json` | actionable | unresolved concrete defect (cancelled request keeps retrying), no reply yet |
| thread-02 | `fixtures/threads/thread-02.json` | actionable | unresolved concrete defect (inverted TTL comparison), wrong behavior spelled out, no reply |
| thread-03 | `fixtures/threads/thread-03.json` | responded | author replied with the fix and a CI run link; no further action requested |
| thread-04 | `fixtures/threads/thread-04.json` | responded | author confirmed, fixed, and linked the green nightly run |
| thread-05 | `fixtures/threads/thread-05.json` | resolved | `resolved: true` with a concluding reply |
| thread-06 | `fixtures/threads/thread-06.json` | resolved | `resolved: true` with a concluding reply |
| thread-07 | `fixtures/threads/thread-07.json` | blocked | explicitly waiting on a cross-team policy decision outside the PR |
| thread-08 | `fixtures/threads/thread-08.json` | blocked | explicitly blocked on an external vendor decision |
| thread-09 | `fixtures/threads/thread-09.json` | skip | pure style nit ("prefer const"), explicitly optional |
| thread-10 | `fixtures/threads/thread-10.json` | skip | changelog/out-of-scope remark, explicitly not for this PR |
