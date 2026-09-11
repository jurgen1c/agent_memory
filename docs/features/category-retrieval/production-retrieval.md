# Production searchable retrieval (AM-91)

`query`, `context`, and `show` now accept explicit `--format-version 2`. V1 remains
the default; `--format-version 1` accepts legacy options and returns legacy shapes.
The exported `queryClaimsV2`, `buildContextV2`, and `showClaimV2` return the AM-90
`ContextOutputResult`, including bounded stdout and its exit code.

```sh
agent-memory compile
agent-memory query actor_user_id --format-version 2 --json
agent-memory context --format-version 2 --task 'receipt retry' --budget medium --json
agent-memory query --format-version 2 --changed-files src/receipts-controller.ts src/diagnostics-controller.ts --json
agent-memory query --format-version 2 --symbol RetryReceipt --route 'POST /retry' --json
agent-memory query --format-version 2 --system accounts --status current --json
agent-memory show accounts.receipt_retry --format-version 2 --max-bytes 65536 --json
```

The query/context selector is shared. Inputs use unique NFKC lowercase Unicode
letter/number/underscore prefix tokens joined with OR, with a 64-KiB UTF-8 input
limit and no raw FTS syntax. Exact authored files/symbols/routes rank before prose,
related files, watched-index membership, then facet browse. Watched membership
requires both a matching watched path and claim glob from the same index. Prose
scores sum `ln(1 + N / (1 + df))` once per distinct task token, using the filtered
eligible corpus. Title, statement, tags and body sections are compiled into token
postings; tags alone do not establish prose evidence or affect its IDF. Final ties
use code-point ID order. Reasons describe authored associations and generated
ranking; they do not verify implementation semantics.

Each selected claim includes canonical repository-relative path, complete section
excerpts, normalized-body SHA-256, and `cacheFreshness: current`. Sections use a
CommonMark syntax tree (including setext headings, fenced/indented code and HTML
blocks), exact LF-normalized text, heading occurrence and body-relative line.
Query/context omit duplicate full-body/metadata payloads; complete `show` includes
both plus every authored association, or returns `BUDGET_TOO_SMALL`. No stored
verification command or Markdown/YAML content is executed.

`--limit` limits optional roots after ranking. The full direct match count and
all discovered authored `requires` obligations survive that limit. A removed root
which owns an obligation is retained as required context, with its entire closure.
`--depth` (default 0, range 0–10) limits optional relationship expansion only;
`--include-inferred` enables inferred optional edges. Required cycles terminate by
ID. Out-of-filter requirements name violated facets; inactive/missing requirements
are incomplete. Canonical validation still rejects dangling graph references;
defensive retrieval also diagnoses missing targets in an existing compiled graph.
Canonical deletion after compilation returns `CACHE_STALE` first.

No-match is successful with `NO_TASK_MATCH`; optional `--baseline` admits eligible
critical claims only when there are no exact/prose hits. It never grants them task
match status. System/status facets are available here. Category/tag vocabulary and
collection integration remain their respective subsequent tickets; collections
report `not_requested`. Existing v1 collection commands and selectors are unchanged.

Compilation reconstructs schema 2 in a temporary database, checks the same complete
canonical-content fingerprint captured before validation/loading, then atomically
replaces the selected cache with rollback on installation failure. The existing v1
tables retain their shape; body/section/token side tables and
`canonical_content_hash` are additive. `canonicalContentDigest(loadedConfig)` is the
shared integration seam for subsequent audit/adoption cache health, alongside
existing config/inventory/provenance metadata. It includes config bytes and sorted,
length-delimited canonical paths/content, never source execution or unrelated repos.
Retrieval checks schema, selected-checkout provenance, canonical fingerprint, body
digests and current source eligibility before returning excerpts.

Missing caches require compile. Schema-1/unknown caches return
`CACHE_SCHEMA_UNSUPPORTED`; changed canonical content/config/checkout returns
`CACHE_STALE`. Both require recompilation in the selected checkout. No read command
silently recompiles. Global caches retain checkout-specific identities and private
permissions; another consumer's cache is untouched. For rollback, pin the prior
package and recompile its disposable selected cache from unchanged canonical files.
Do not feed schema 2 to an old binary or delete another registry checkout's cache.

## Reproduction evidence

Run `bun tests/fixtures/category-retrieval/measure-production.ts` to compile and
probe disposable sanitized repositories through the exported production APIs.
`tests/integration/retrieval_v2.test.ts` also bundles/runs the Node CLI. Fixtures
never modify a real consumer or contact a network service.

Observed production results (medium, UTF-8 bytes including final LF):

| Corpus / probe | First root | Retry coverage | Identity coverage | Bytes |
| --- | --- | --- | --- | ---: |
| Original / full | aaa.storage | 4/4 | 0/2 | 8967 |
| Corrected / full | accounts.receipt_retry | 4/4 | 0/2 | 9033 |
| Corrected / short | accounts.diagnostics_retry | 4/4 | 0/2 | 7318 |
| Corrected / two controller files | accounts.diagnostics_retry | 4/4 | 2/2 | 11344 |
| Corrected / full plus files | accounts.receipt_retry | 4/4 | 2/2 | 12769 |
| Original / body-only actor_user_id | accounts.receipt_retry | 4/4 | 0/2 | 6451 |
| Original / held-out signing keys | identity.rotation | 4/4 distractors | 2/2 | 9118 |
| Corrected / held-out signing keys | identity.rotation | 4/4 distractors | 2/2 | 9184 |
| Either / negative control | none | 0/4 | 0/2 | 661 |

The unchanged original corpus has zero legacy body-disabled `actor_user_id` hits
and a direct v2 body hit; bodies and graph dependencies remain byte-identical
between variants. Original controller-only input has zero exact/prose hits and
only watched suggestions. Corrected metadata supplies exact owning associations,
so both endpoints become tier 1. This is a separate curation gain. The held-out
expected pair is `identity.rotation` and `identity.overlap`; generic OR terms also
retain all four retry claims. These results demonstrate the specified behavior,
not perfect precision, replay of the full historical consumer, or time savings.
