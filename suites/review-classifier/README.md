Labeled review-thread suites for the review-classifier role: each case = {thread payload, expected verdict} in WS-E's verdict vocabulary (plan §3.2; ws-j item 3).

`micro/` is the populated suite (phase-3 J3, 2026-09-16): ten fictional, recorded-SHAPE thread
payloads (`fixtures/threads/thread-{01..10}.json`), two per expected verdict — actionable,
responded, resolved, blocked, skip — with the payload-to-verdict table in `micro/PROVENANCE.md`.
The classifier's structured output must be `{"verdict": <one of the five>}`; scoring is a
verdict match. The judge contract and the fake-smoke `--driver-name subprocess` labeling
decision are recorded in `suites/README.md`.
