# Contamination canaries — provenance

`suites/fixer-worker/canary/` holds four **synthetic reproductions of well-known
public bug classes** (F7 slice B). They are not benchmark instances and no
third-party code is vendored: each case re-derives the *behaviour* of a public
bug class on a clean, zero-dependency TypeScript substrate and is materialized
by the same deterministic generator as the breadth corpus
(`catalog/generate-canaries.ts` → `renderCase`/`caseEntry` in
`catalog/generate-cases.ts`).

**Reporting:** this suite is reported in its own table namespace
(`reports/canaries/<model>/<driver>/…`) and is **never** mixed into, or counted
toward, the headline breadth scores. A canary score materially above the
contemporaneous headline breadth score is a contamination signal, not a good
result — it triggers a re-audit of the headline corpus before the delta is
trusted.

| case | public bug class / reference | what was derived | license |
| --- | --- | --- | --- |
| canary-01 | Half-open interval overlap off-by-one (Allen's interval algebra: `overlaps = aStart < bEnd && bStart < aEnd`) | The inclusive-boundary fault `bStart < aEnd` → `bStart <= aEnd` on a clean `schedule`/`src/slots.ts`; a back-to-back slot is wrongly reported as overlapping. Tests authored for this repo. | Source: public interval-algebra definition (documentation only). License: none needed for the derivation. **Vendored: none.** |
| canary-02 | Defensive-copy / shared-reference-return aliasing (MDN `Array.prototype.slice()` copy guidance) | The fault `return [...(adj[node] ?? [])];` → `return (adj[node] ?? []);` on a clean `graph`/`src/paths.ts`; `neighbors` leaks its internal list so a caller's mutation corrupts later reads. Tests authored for this repo. | Source: public API documentation (documentation only). License: none needed for the derivation. **Vendored: none.** |
| canary-03 | Missing-radix `parseInt` (MDN `parseInt` radix parameter; ESLint `radix` rule) | The fault `parseInt(text, 10)` → `parseInt(text)` on a clean `validate`/`src/number.ts`; a hex-looking string parses as base sixteen. Tests authored for this repo. | Source: public language/library documentation (documentation only). License: none needed for the derivation. **Vendored: none.** |
| canary-04 | Prototype pollution via unchecked merge keys (lodash advisories CVE-2019-10744 / CVE-2018-3721) | The clean `merge` substrate (`catalog/substrates/merge/`) skips `__proto__`/`constructor`/`prototype`; the fault removes that guard so a `JSON.parse('{"__proto__":{…}}')` payload reaches `Object.prototype`. Tests authored for this repo. | Source: public security advisories (behaviour only; **no lodash code copied**). License: none needed for the derivation. **Vendored: none.** |

Every `fixtures/canary-0N.FAULT.json` record carries
`provenance.origin = "public-bug-canary"` plus `provenance.reference` and
`provenance.license`. No real-repo content is included: every row above is a
behavioral re-derivation, so there is nothing to license beyond the public
documentation the row names.
