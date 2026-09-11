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
match status. Category/tag/system/status facets are available.
Collection integration remains a subsequent ticket; collections
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

## Category vocabulary and exact facets (AM-92)

```sh
agent-memory categories list --counts --json
agent-memory categories list --system ingestion --status current --json
agent-memory query --format-version 2 --category security --category reliability --json
agent-memory context --format-version 2 --category reliability --system ingestion --status current --json
agent-memory query --format-version 2 --tag concern:security --json
```

`categories list` is intrinsically v2; it optionally accepts `--format-version 2`.
`listCategories({cwd, counts, filters: {systems, statuses}, budget, maxBytes})`
exports the same typed model. Entries sort by slug and include descriptions,
zero-count vocabulary entries and virtual `uncategorized`. Without `--counts`,
count properties are absent. Counts are distinct eligible claims, with no graph
expansion. The entire list, filters and self-accounting budget must fit the cap;
an undersized cap returns `BUDGET_TOO_SMALL` (exit 7), never a partial vocabulary.
Human and JSON output honor the same cap and model. Presets and errors use the
shared v2 budget rules above.

Categories are authored only as `concern:<slug>` in claim `tags`. Ordinary tags
remain exact free-form labels: `security` is not `concern:security`. Claims with
no concern tag remain valid and browse under `uncategorized`; that virtual name
cannot be authored as `concern:uncategorized`. Duplicate/empty tags and unknown
reserved concern tags fail validation. A parallel claim `categories` field is
rejected; existing profile `category` remains independent.

Built-in meanings are security (authority, privacy, access), reliability (recovery,
idempotency, durable handoffs), billing (charges, entitlements, usage), localization
(language/locale), and delivery (review/verification). Maintainers may extend them
in repository config without redefining a built-in:

```yaml
category_vocabulary:
  privacy: "Personal-data collection, disclosure and retention"
```

Slugs match `[a-z][a-z0-9]*(?:-[a-z0-9]+)*`, at most 48 ASCII bytes. Descriptions
are nonempty strings, at most 512 UTF-8 bytes. Duplicate YAML keys and reserved
`uncategorized` are errors. Vocabulary is checkout-owned and participates in the
canonical config digest: recompile after any config edit. It is never merged with
another registry entry. Compilation adds derived `claim_categories` and tag indexes
to schema 2; v1 tables/output remain compatible and tags remain the source of truth.

All facets match exactly and case-sensitively: OR within repeated values, AND
across category/tag/system/status. Applied arrays deduplicate and sort. Facet-only
query/context is browse (`taskMatches: 0`); no text, files or facets is `INPUT_REQUIRED`.
Unknown category/system/status is a usage error (exit 2); category errors suggest
`categories list` and bounded legal values. Unknown ordinary tags succeed empty.
Default statuses are `current`, `proposed`, `needs_review`; explicit statuses replace
them and support `stale`, `deprecated`, `experimental`, `needs_verification`, `rejected`
as well. Required claims cross all facets with `REQUIRED_DEPENDENCY/outsideFilters`;
inactive, missing and budget-omitted obligations remain incomplete. Direct and
opted-in baseline roots always obey facets.

Repeated singleton/boolean flags (including positive/negative pairs), multiple
positional query texts and `--include-stale` in v2 are usage errors. Use repeated
`--status` instead. Existing v1 flags retain their meaning; new category/tag options
require explicit format 2 on existing commands. No stored verification command is
executed by retrieval.

For rollback, restore the pinned prior package, revert reviewed concern/config
changes if that validator rejects them, and compile only the selected disposable
cache with that package. Keep canonical documents and other registry caches intact.
Category adoption and consumer semantic edits require their separate workflow.

## Guided adoption and workflow collections (AM-94)

Existing and mixed legacy/category memories remain valid. Use
`agent-memory upgrade --adopt-retrieval --format-version 2 --json` to inventory
only the current checkout and preview the ordinary support/config upgrade.
`--write` installs managed guidance and allowed support updates after preflight;
it never changes canonical claims, graphs, recipes, verification commits or status.
See [the complete adoption workflow](adoption.md) for bounded inspection, review,
explicit consumer edits, actual validation/probes, custom references and rollback.
Global migration is a separate command; adoption never reads personal memory or
other registry consumers and its dry-run never resolves or writes the cache.

V2 context reuses recipe matching, plan/stage selection and profile conflict and
eligibility rules. `--recipe`, `--plan --stage`, `--profile`, and
`--profile-trait` retain their existing meanings. Context matches recipes from
text/files/claims; plans are selected explicitly, as in v1 context. Profiles use
existing aliases, conditions and conflicts; disabling profile traits in config
returns `not_requested`. Each collection reports `totalEligible`, `matched` and
`empty|no_match|matched|not_requested`. V2 query keeps every collection
`not_requested`. V2 discovers all matched obligations before the shared byte cap,
instead of using v1 item caps. Required claims and their complete `requires`
closure survive filters and optional limits; omission or inactivity is incomplete.

Files and commands retain all claim/recipe/plan source IDs and canonical paths,
are deduplicated and share the output cap. Commands always remain
`suggested_not_run`. Listing a verification command, compiling memory, or resolving
an authored commit does not establish that a behavioral check passed.

The public `planRetrievalAdoption` API returns the read-only plan;
`applyRetrievalAdoption(plan)` rereads all inputs and rejects changed plans with
`ADOPTION_PLAN_STALE` (exit 5). Validation, duplicate IDs, unsafe or symlink paths,
and conflicting output paths fail before writes (exit 4). Late write failures
restore prior files and newly created directories; rollback failures are reported.
Unflagged upgrade and the v1 context API retain their existing result shapes.
