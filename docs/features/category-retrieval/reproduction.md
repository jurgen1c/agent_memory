# AM-88 reproduction and measurement record

Evidence date: 2026-09-08 (Costa Rica). Base source:
`14c3fb6d81433538ff8ef38f35c5ea0efbb9ea26`. Package version is 0.4.0.
The installed bundle read from Facturi's dependency has SHA-256
`590818f4d0bfe62e58cab12b388ccbdc05d1355e763f1d89b59729b74b2dec3e`, identical to
the historical audit inventory. The original audit inspected source at
`678f0dcf321c52e0de2aa42b69b9716342a5a240` and Facturi at
`0b5f592c78b211084e88523234c8d11e9b12989d`.

## Repeat the experiment

From this repository after `bun install --frozen-lockfile`:

```sh
bun test tests/unit/category_retrieval_contract.test.ts
bun tests/fixtures/category-retrieval/measure.ts
bun tests/fixtures/category-retrieval/examples.ts
# Optional comparison to an existing installed 0.4.0 bundle:
ASDF_NODEJS_VERSION=26.7.0 bun tests/fixtures/category-retrieval/measure.ts /absolute/path/to/installed/dist/agent-memory.js
```

The optional executable path is operator-supplied package code, never read from
memory content. The runner compiles and probes disposable sanitized repos and
removes them afterward. Tests never download a dependency or contact a service.
The measurement runner is explicit, outside `bun test`; it reports elapsed time
but has no speed assertion. Probe argument arrays, expected/observed claim IDs,
top result, bytes, warnings and reference coverage are emitted as JSON. Do not
redirect generated reports into the canonical memory tree or commit local paths.

The first restricted installed-CLI run returned empty stdout with status 0; the
runner rejected it instead of recording success. Repeating with approved Git/
subprocess access completed. This is an execution limit, not proof of empty
retrieval. Current-source probes ran successfully in both environments. Installed
version probe, compilation and queries operated only on temporary fixtures.

## Historical audit versus this fixture

Historical Facturi observations supplied by AM-88, corroborated against the local
read-only report and inventory:

| Input (medium except negative) | Required claims / 4 | Files | Commands | JSON bytes |
| --- | ---: | ---: | ---: | ---: |
| Full task | 2 | 84 | 26 | 59,831 |
| Title | 2 | 85 | 43 | 55,670 |
| receipt retry | 4 | 55 | 25 | 42,135 |
| Four source files | 0 | 72 | 40 | 41,206 |
| receipt retry + files | 4 | 58 | 25 | 42,534 |
| Negative control, small | 0 | 174 | not recorded here | 58,051 |

These are historical measurements, not reruns of the full 157-claim consumer.
The eight-claim sanitized corpus is deliberately smaller; it does **not** reproduce
the historical 2/4 recall loss. It exposes ordering, body omission, silent fallback,
and the difference between algorithm changes and source curation. Full corpus
replay and more held-out tasks remain eventual release gates; no general retrieval
accuracy or engineering time-savings claim is made.

Sanitized ID mapping:

| Historical reference | Fixture |
| --- | --- |
| account_memberships.interaction_receipt_detail_manual_retry_parse | accounts.receipt_retry |
| account_memberships.interaction_ingestion_diagnostics_manual_retry_parse | accounts.diagnostics_retry |
| receipt_ingestion.interaction_parse_recovery_scan_retries_stale_and_pending_receipts | ingestion.recovery |
| receipt_ingestion.workflow_dispatch_outbox_preserves_pipeline_handoffs | ingestion.outbox |

Bodies contain owner/admin authorization, account lookup, attempts_exhausted,
locking, bounded attempts and dispatch handoffs. The broad index watches `src/**`
and includes all `claims/**/*.md`; `aaa.storage` is a keyword distractor.
Two identity/key-rotation claims are a separate held-out subsystem. `legacy.notes`
has no categories. The defective variant changes only endpoint source paths to
`src/remove-member.ts`, summaries to the generic scaffold, and tags to self-ID.
Required edges and bodies remain identical between variants. Fixture source files
are inert placeholders, **not proof** that the authored contracts are implemented.

## Recorded sanitized results

Corrected corpus; installed/current values exclude/include the CLI trailing LF as
noted. Prototype byte usage always includes LF and self-accounting envelope.

| Probe | Current source top / hits | Installed top / hits | Current / installed bytes | Model top / hits | Model bytes |
| --- | --- | --- | ---: | --- | ---: |
| Full task | aaa.storage / 4 | aaa.storage / 4 | 8,970 / 8,971 | accounts.receipt_retry / 4 | 6,216 |
| Short task | accounts.receipt_retry / 4 | accounts.receipt_retry / 4 | 7,982 / 7,983 | accounts.diagnostics_retry / 4 | 5,391 |
| Two controller files | aaa.storage / 4 | aaa.storage / 4 | 11,498 / 11,499 | accounts.diagnostics_retry / 4 | 8,870 |
| Full task + files | aaa.storage / 4 | aaa.storage / 4 | 11,908 / 11,909 | accounts.receipt_retry / 4 | 8,867 |
| Body-only actor_user_id | aaa.storage / 4 (fallback) | aaa.storage / 4 (fallback) | 11,395 / 11,396 | accounts.receipt_retry / 4 | 5,391 |
| Negative, small | aaa.storage / 3 (fallback) | aaa.storage / 3 (fallback) | 4,616 / 4,617 | none / 0 | 533 |
| Held-out signing keys | identity.rotation / 4 retry distractors | identity.rotation / 4 retry distractors | 7,452 / 7,453 | identity.rotation / 4 retry distractors | 7,269 |

The held-out gate is top-result relevance and inclusion of both `identity.rotation`
and `identity.overlap`, not absence of every generic lexical match. Its full wording
contains generic “without/active” terms, so it also retrieves retry claims. This
explicit residual demonstrates that OR-prefix retrieval has imperfect precision;
it does not conceal those extra claims as improved relevance. Required identity
coverage is 2/2 and complete, comfortably within medium. Add additional independently
curated held-out tasks before release.

For the original defective corpus, model full task still leads with `aaa.storage`
(6,145 bytes); corrected metadata moves the owning endpoint first (6,216). That
ranking gain includes **curation**, not algorithm alone. On the unchanged original,
`actor_user_id` with body search disabled has zero direct matches, while enabling
body search retrieves the endpoint Authorization and Failure modes sections with
provenance. Exact controller-only input without broad-index expansion has no
original match and a corrected exact owner match. These independent assertions
prevent attributing a repaired source link to ranking.

`query --category` and subsystem-only `query --system accounts` fail on both
production implementations. `query actor_user_id` has no matches and `show` omits
the authorization body on both. No audited package defect is claimed fixed in
production by this PR. Current audit already distinguishes timeout/null-status
unavailability; its `unavailableGitFailure` still only checks `timedOut` or null
status, explaining the status-0 permission case. The executable model covers it.

## Budget calibration and stress

Select the smallest power-of-two KiB cap above each measured target scenario:

| Preset target | Measured bytes | Selected cap | Interpretation |
| --- | ---: | ---: | --- |
| Two identity claims, complete filtered browse | 2,334 | 4,096 | Small focused brief; not promised to fit every required closure |
| Largest normal corrected probe (broad controller index) | 8,870 | 16,384 | Medium includes the four retry claims for full/short/file inputs |
| Complete retry closure with 4,000 escaped Unicode repetitions in outbox | 53,394 | 65,536 | Full remains bounded while fitting this long-body case |

Calibration outputs are emitted by `examples.ts`; tests verify actual compact JSON
with its LF, not pretty-printed example-file length. Timing is observational:
the initial successful model measurement runs took roughly 2–30 ms per normal
scenario on this machine; a stress-test run took approximately 650–800 ms total
across multiple cap probes. Values vary with warm-up, scheduling and hardware;
there is no performance guarantee. Production SQL/indexing benchmarks remain open
implementation validation, not an unresolved public contract.

Budget tests add 200 source files, 200 commands containing escaped quote/backslash
and non-ASCII text, repeated required edges, a cyclic closure and a long body.
They exercise 1,024/4,096/16,384/65,536-byte caps, compare `Buffer.byteLength` to the
self-reported total, check unique payload/edge IDs, JSON round-trip and incomplete
required context. A large filter envelope and a tiny invalid cap exercise explicit
budget errors. This is meaningful serialized-cost evidence, not a claim-count cap.

Git fixtures inject EPERM/EACCES with status 0 and stdout, ENOENT, ETIMEDOUT,
unknown errors, malformed output, non-commit objects, successful verification and
an actual temporary-repo `git cat-file --batch-check` missing-object response with
status 0. Only missing-object recommends reviewing/repairing the reference.
Adoption fixtures compare original content before/after planning, local/global mode,
repeatability and content-fingerprint changes; production upgrade writes are not
part of the model.
