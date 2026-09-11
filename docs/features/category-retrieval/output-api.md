# Production v2 output API (AM-90)

The core library now exports `packContextOutput`, `serializeContextOutput`,
`renderContextOutputHuman`, `contextOutputError`, `boundContextDiagnostics`,
`resolveContextOutputCap` and their `ContextOutput*` types. This implements the
output foundation from the [engineering contract](specification.md). AM-91 now supplies the [production query/context/show adapters](production-retrieval.md);
existing v1 CLI output and exports are unchanged.

## Selector integration

Pass a `ContextOutputRequest` and `ContextOutputCandidates` to
`packContextOutput`. The selector owns source/cache eligibility, normalized
repository-relative paths, category/system/status vocabulary validation, request
validation, evidence ranking, optional depth expansion, and collection matching.
The packer is pure in-memory code; it never reads or executes stored content.

- Supply ranked `roots` with explicit reason codes and generated `evidence`.
  Selectors applying an optional-root limit supply the full pre-limit
  `taskMatchCount` and seed every removed root that owns required obligations via
  `requiredClaimIds`, so neither matching diagnostics nor obligations disappear.
  Multiple reasons for an ID are merged. Task matches count unique eligible
  text/exact roots before packing. Optional related/index rows are never matches.
- Supply claim payloads and graph relationships, including every outgoing
  authored `requires` edge needed for transitive closure. Duplicate IDs retain
  the first payload; duplicate relationship triples retain explicit required
  authority over an inferred copy. Conflicting canonical IDs must be rejected
  by the selector/validator before this seam.
- Supply `requiredClaimIds` for explicit non-graph obligations. Collection items
  may supply their own authored `requiredClaimIds`. Missing IDs remain missing
  diagnostics; do not pre-count them as omitted payloads. The packer retains the
  complete obligation set even after its originating root/collection is removed.
- Sections carry heading, optional occurrence, 1-based body-relative start line,
  and whole text. The enclosing claim provides ID, canonical source path and
  optional normalized-body SHA-256. AM-91 supplies the complete body/digest and
  parsed sections, metadata and authored associations through these typed fields.
- File/command suggestions supply normalized values and every originating
  claim/recipe (or plan/profile) ID and canonical source path. Unknown origins
  are excluded; suggestions are ordered by their highest-ranked contributor.
  All retained command origins survive as `state: suggested_not_run`.
- Collections preserve selector-supplied `totalEligible`, `matched`, and `state`.
  Duplicate item IDs retain the first ranked payload and its authored obligations.
  An omitted collection item does not change matching diagnostics. Unrequested
  collections default to `not_requested`. Opaque collection `data` is authored
  content; put emitted claim links in `requiredClaimIds`, which is filtered to
  retained payloads. Missing and omitted links are diagnosed independently.

The packer applies exact OR-within/AND-across facet checks to roots, including
baseline roots. Only explicit required context crosses facets; it carries every
violated facet in `outsideFilters`. Baseline requires opt-in and zero direct task
matches. Browse stays browse with zero task matches. Required inactive statuses
are incomplete authored context, never upgraded to active guidance.

## Rendering and budgets

Use the returned `stdout` directly: compact JSON plus one LF, with an exact UTF-8
`budget.usedBytes` fixed point. Do not add another newline or banner. Use the
returned `exitCode` rather than v1 error mappings. `stderr` is separately bounded
to 2 KiB. The human renderer reads this same selected model and independently
checks the cap, falling back to the bounded complete JSON representation if its
layout expands beyond it. Neither renderer runs verification commands.

Packing caches immutable encoded record sizes and updates byte totals, graph links,
collection references and omission counters incrementally. The same sequential
removal order is preserved across warning and decimal-width transitions; the
actual final serialization independently confirms the cap. A 3,000-claim
regression bounds encoded work, and a straightforward serialization oracle checks
output parity across small-budget transitions.

Packing removes lowest-ranked commands, then files, then optional collections
and optional claims, before required groups. Within a class, later ranked items
are removed first. Required graph endpoints retain priority over unrelated roots.
Payloads and sections are whole; removed unique claims, required payloads, edges,
sections, files, commands and collection items are counted explicitly. Graph links
only connect emitted claim payloads. The minimum complete success envelope may
exceed 512 bytes; valid caps that cannot hold it return the fixed exit-7
`BUDGET_TOO_SMALL` error. Invalid caps return the same compact error with exit 2.

`serializeContextOutput` is a low-level accounting primitive which updates
`budget.usedBytes`; adapters should use `packContextOutput` for cap enforcement.
Keep any future extension fields in the selected model before serialization so
their bytes participate in packing. Complete `show` inspection must reject an
oversized complete claim rather than treating a truncated pack as complete.

## Validation evidence

`tests/unit/context_output.test.ts` imports the production exports and covers
normal/browse/no-match/baseline envelopes, exact caps, Unicode/escaping/list stress,
required cycles, omitted-origin obligations, inactive/missing required context,
suggestion provenance and collection state. `tests/integration/context_output.test.ts`
uses disposable Git repositories and a Node-target production bundle, checks inert
verification strings, deterministic output, and built CLI help/version parity.
The AM-88 fixture model remains separate comparison evidence.
