# Issue #30: CLI fixer token cap

The WB-1 run gated claude-agent and subprocess fixer tails after 18/45 and
8/45 cases respectively. Their case usage included about 300k–470k cacheRead
tokens, while the workflow allowed 60k tokens per case and the governor counts
cache reads.

PR #35 (merge `be6e39b`) sets 600k tokens per case for those two fixer lanes
only. All other role/driver cells retain 60k. The D9 per-case USD ceiling
still applies to every invocation.

Manual proof run [36730979732](https://github.com/camerontaylor/cq-fixtures/actions/runs/36730979732)
produced 45/45 claude-agent fixer rows (5 micro, 12 breadth-verified, 28
breadth-tail) at a modeled $0.1430376 total. Input/output/cacheRead were
219,232/113,496/1,780,160 tokens; the largest case totaled 135,813 tokens,
below the new 600,000 per-case cap. All three run records carry the $0.10
per-case D9 USD ceiling. The provider's billed amount and subscription credit
consumption are not exposed in the artifact; those remain unknown.

The job failed after producing all rows because an apostrophe in the workflow's
inline `node -e` scanner broke shell quoting. This follow-up fixes that scanner
and adds a tripwire. The subprocess fixer proof is still pending; its 45-case
coverage cannot yet be claimed.
