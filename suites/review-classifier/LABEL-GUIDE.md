# Label guide — review-classifier breadth suites

Version: **1.0 (2026-09-21)**. This guide is the normative labeling reference for
`suites/review-classifier/breadth-verified` and `suites/review-classifier/breadth-tail`.
The scored output stays exactly `{"verdict": <actionable|responded|resolved|blocked|skip>}`
(schema-bound). Everything else on this page — rule chain, routing layer, FP flag,
procedure — decides what that verdict must be for a given thread.

## 1. Rule chain R0–R6 (verbatim from the R6 sourcing digest §3.3)

Rules apply in priority order; the first matching rule decides. The routing layer is the
digest's 15-group routing taxonomy plus Turzo & Bosu's `False Positive` as a dedicated
negative flag (methodology only — no vendored content from either source).

```
R0  resolved=true AND (concluding reply OR author confirms fix)          → resolved
R1  thread waits on an external decision (policy/vendor/cross-team)       → blocked
R2  comment explicitly optional / nit / out-of-scope / changelog remark   → skip
R3  author replied with a fix + evidence and asks nothing further         → responded
R4  unresolved concern, group ∈ {Logic & functionality, Implementation,
    API documentation, Resource, Performance, Validation/Security,
    Interface}                                                            → actionable
R5  unresolved concern, group ∈ {Appearance/Formatting, Naming,
    Code organization, Documentation} → actionable only if PR policy
    flags it; else skip
R6  Discussion/Design/Question with no reply → actionable if it demands
    a concrete change, else skip; Praise → skip
FP flag  content reads like a defect but the code/context shows it is
    correct, or reviewer explicitly calls the concern invalid            → expected ≠ actionable
```

State rules (R0–R3) take precedence over group routing (R4–R6): thread state decides
`resolved`/`blocked`/`responded`, concern group decides `actionable`-vs-`skip`.
A reply that neither resolves, unblocks, evidences a fix, nor retracts the concern does
not change routing — the thread is graded as if the reply were absent (this is what makes
adversarial-reply cases gradeable; see §5).

## 2. Routing-layer group names

The 15 routing groups are the digest §3.3 rule-chain sets, treated as three groups for
Discussion/Design/Question plus Praise: Logic & functionality, Implementation,
API documentation, Resource, Performance, Validation/Security, Interface,
Appearance/Formatting, Naming, Code organization, Documentation, Discussion, Design,
Question, Praise. Names only — no definitions are imported from any external source.
Every case records its group in `task.notes` and `label.json` (`concern_group`).

## 3. FP-flag definition

`fp_flag: suspicious-benign` marks a case whose payload *looks* alarming but whose
adjudicated verdict is not `actionable`: alarmist tone on a preference, a
plausible-but-wrong defect claim on correct code, or a resolved thread carrying a
still-scary comment. The flag means `expected ≠ actionable` — it never changes which
state rule fires, it constrains the verdict to `responded`, `resolved`, `blocked`, or
`skip`. Routing principle for invalid concerns: an evidenced author response routes
`responded` (R3); a concluding resolution routes `resolved` (R0); an external wait routes
`blocked` (R1); an explicitly optional framing or a retraction routes `skip` (R2/R5/R6).
Corpus construction guarantees every suspicious-benign case carries one of those
landings, so no invalid concern falls through to R4.

## 4. Worked examples (4 per verdict)

Each example: thread sketch → rule applied → verdict + fp_flag.

### actionable

- **A1 — off-by-one, no reply.** Reviewer shows page 1 of results is skipped (1-based vs
  0-based), `resolved: false`, no replies. R4 (Logic & functionality, unresolved).
  → `actionable`, fp `none`. (Corpus: bv-01.)
- **A2 — hollow "fixed, PTAL".** Reviewer shows an N+1 loop; author replies "Tweaked the
  loop, PTAL" with no evidence and an implicit re-review request. Not R3 (asks something
  further, no evidence) → R4 (Performance, unresolved). → `actionable`, fp `none`,
  adversarial. (Corpus: bv-04.)
- **A3 — open redirect, unresolved.** Reviewer shows the `next` param flows unvalidated
  into a redirect with an exploit sketch, no replies. R4 (Validation/Security).
  → `actionable`, fp `none`. (Corpus: bv-02.)
- **A4 — design question demanding a concrete change.** Reviewer asks whether a
  distributed lock is needed before merge (double-processing risk); a second reviewer
  replies "anyone able to confirm?" without answering. Non-resolving reply → graded as
  absent → R6 demands-concrete-change. → `actionable`, fp `none`, adversarial.
  (Corpus: bv-06.)

### responded

- **R1 — fix plus CI link.** Reviewer shows an inverted expiry check; author replies with
  the flipped comparison, a regression test, and a green run number, asking nothing
  further. R3. → `responded`, fp `none`. (Corpus: bv-07.)
- **R2 — wrong race claim disproved with evidence.** Reviewer shouts RACE CONDITION on a
  queue; author demonstrates single-threaded draining with a test and a run number, no
  change needed. R3 (evidenced response); FP flag constrains away from `actionable`.
  → `responded`, fp `suspicious-benign`. (Corpus: bv-09.)
- **R3 — perf fix with bench numbers.** Reviewer shows O(n²) dedupe; author rewrites with
  an index map and cites p95 before/after. R3. → `responded`, fp `none`. (Corpus: bv-08.)
- **R4 — wrong injection claim disproved with a scan.** Reviewer claims SQL injection;
  author shows the allow-listed source plus identifier escaping and a clean scanner run.
  R3. → `responded`, fp `suspicious-benign`. (Corpus: bv-10.)

### resolved

- **S1 — concluding reply.** Reviewer shows a CSV escaper ordering bug; author swaps the
  order, adds a fixture, replies "Resolving", `resolved: true`. R0.
  → `resolved`, fp `none`. (Corpus: bv-13.)
- **S2 — author confirms fix.** Reviewer shows a state leak on unmount; author adds
  cleanup, verifies in the sandbox, replies "resolving this thread", `resolved: true`.
  R0. → `resolved`, fp `none`. (Micro: thread-06.)
- **S3 — scary-but-wrong resolved as invalid.** Reviewer shouts DATA LOSS on invoice
  voiding; author walks through soft-delete with witnesses, resolves as invalid,
  `resolved: true`. R0; FP flag constrains away from `actionable`.
  → `resolved`, fp `suspicious-benign`. (Corpus: bv-15.)
- **S4 — nit resolved (precedence demo).** Reviewer nits an identifier name; author
  renames and replies "Resolving", `resolved: true`. R0 fires before R2/R5 are reached.
  → `resolved`, fp `none`. (Corpus: bv-16.)

### blocked

- **B1 — vendor decision.** Comment states the rounding rule depends on the finance
  vendor's unsettled decision, explicitly holding the thread. R1. → `blocked`,
  fp `none`. (Micro: thread-08.)
- **B2 — policy decision.** Comment states the merge semantics await the platform
  council's unpublished conflict policy; no code change requested. R1. → `blocked`,
  fp `none`. (Corpus: bv-19.)
- **B3 — status-check reply still blocked.** Reviewer restates an unanswered vendor quota
  ticket; author asks "any update?" — nothing unblocks. R1. → `blocked`, fp `none`,
  adversarial. (Corpus: bv-21/bv-22 pattern.)
- **B4 — alarmist routine wait.** Comment shouts SHIP-STOPPER over a legal sign-off that
  is a routine gate with nothing broken today. R1 fires on the external wait; alarmist
  tone sets the FP flag. → `blocked`, fp `suspicious-benign`. (Corpus: bv-24.)

### skip

- **K1 — explicit nit.** "Nit, non-blocking: 2 vs 4 spaces, cosmetic, feel free to
  ignore." R2. → `skip`, fp `none`. (Corpus: bv-25.)
- **K2 — out-of-scope remark.** Changelog note explicitly "not asking for changes here."
  R2. → `skip`, fp `none`. (Corpus: bv-26.)
- **K3 — praise.** "Beautiful refactor — no notes, just appreciation." R6 Praise.
  → `skip`, fp `none`. (Corpus: bv-28.)
- **K4 — alarmist preference retracted.** "This name WILL confuse everyone!" followed by
  the same reviewer's "misread — retracting, please ignore." R5 (Naming, no policy flag)
  with an R2-flavored landing; alarmist tone on a preference sets the FP flag.
  → `skip`, fp `suspicious-benign`, adversarial. (Corpus: bv-27.)

## 5. Adversarial-reply patterns

At least 6 of the 60 corpus cases carry a reply whose surface form mimics resolution,
blocking, or withdrawal without delivering it: a hollow author "fixed, PTAL" with no
evidence (still `actionable`, bv-04); a non-answering "anyone confirm?" on a
change-demanding question (still `actionable`, bv-06); status-check and block-restating
replies on external waits (still `blocked`, bv-21, bv-22); a self-retraction that lands
`skip` (bv-27). Classifiers that key on reply presence instead of reply content fail
these by construction.

## 6. Annotation procedure

- **breadth-verified (30):** two independent annotators label all 30 against this guide;
  disagreements go to a third adjudicator. Target Cohen's κ ≥ 0.75 (stretch 0.80). Since
  all annotators are LM lanes, the κ-equivalent agreement is recorded honestly as
  inter-pass agreement, never presented as human κ.
- **breadth-tail (30):** LM-draft plus one annotator, with a 20% random double-coded
  audit requiring κ ≥ 0.70; any audit case below threshold is re-adjudicated or dropped.
- Every adjudication is recorded in the case's `label.json` beside the payload, so the
  label chain — not just the label — is auditable.

## 7. Re-adjudication rule

A rule-chain version change forces re-adjudication of the affected tier — never silent
relabeling. Bumping `rule_chain_version` in `label.json` without a recorded
re-adjudication is a label-drift CI failure.

## 8. label.json field spec

```jsonc
{
  "case": "bv-NN",                    // suite case id
  "suite": "breadth-verified",        // owning suite
  "expected": "<verdict>",            // must equal the suite.json probe expected
  "concern_group": "<§2 group name>", // routing layer
  "fp_flag": "none" | "suspicious-benign",
  "adversarial_reply": false,         // true iff §5 pattern present
  "rule_chain_version": "1.0",        // this guide's version
  "annotators": [                     // one entry per independent pass
    { "id": "executor-pass1", "verdict": "<verdict>" }
  ],
  "adjudication": {                   // status + record of the third-pass decision
    "status": "pending-pass2" | "agreed" | "adjudicated",
    "by": "<annotator id>",
    "decision": "<verdict>",
    "note": "<what was decided and why>"
  }
}
```

The runner reads ONLY `fp_flag` (see `runner/index.ts` `suspiciousBenignFlag`); every
other field exists for the label-drift CI check and human audit.
