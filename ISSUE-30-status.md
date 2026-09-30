# Issue #30: CLI fixer token cap

The WB-1 run gated claude-agent and subprocess fixer tails after 18/45 and
8/45 cases respectively. Their case usage included about 300k–470k cacheRead
tokens, while the workflow allowed 60k tokens per case and the governor counts
cache reads.

This branch sets 600k tokens per case for those two fixer lanes only. All
other role/driver cells retain 60k. The D9 per-case USD ceiling still applies
to every invocation. A fresh dispatch must prove complete fixer case counts;
until then, these two cells remain partial evidence.
