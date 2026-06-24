# Semantic Embeddings for Agent Memory

Status: future feature, outside MVP

## Summary

Agent Memory could support optional semantic retrieval by embedding memory artifacts and querying those embeddings alongside the existing SQLite full-text index.

This should not replace canonical memory. Markdown claims, YAML graphs, indexes, recipes, and waivers remain the source of truth. Embeddings would be a generated retrieval cache, similar to `.agent-memory/memory.sqlite`.

## Why It Could Help

Current retrieval is strongest when the user query shares words with memory:

- exact terms
- claim IDs
- file paths
- symbols
- tags
- system names

Embeddings would improve recall when language differs but meaning is close. For example, a task like "fix tenant-specific login collision" could surface a claim titled "Student OAuth UID is tenant scoped" even if the query does not use "OAuth UID".

## Recommended Shape

Use hybrid retrieval:

1. Run existing SQLite FTS search.
2. Run vector similarity search over generated embeddings.
3. Merge rankings.
4. Apply existing metadata boosts for system, status, severity, changed files, and watched files.
5. Expand through graph relationships.
6. Return normal agent context.

Embeddings should be generated for precise artifacts, not entire documentation trees:

- one embedding per atomic claim
- one embedding per recipe summary
- optional embeddings for migrated legacy documentation chunks
- optional embeddings for system or index summaries

Avoid embedding broad docs by default. Large mixed-purpose documents add noisy matches and weaken the atomic-claim model.

## SQLite Storage Sketch

SQLite can support this with either an extension-backed vector table or a simpler portable fallback.

Potential metadata table:

```sql
CREATE TABLE embedding_items (
  id INTEGER PRIMARY KEY,
  artifact_type TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  system TEXT,
  status TEXT,
  content_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
```

Potential vector table with a vector extension:

```sql
CREATE VIRTUAL TABLE embedding_vectors USING vec0(
  embedding float[768]
);
```

The vector row ID would match `embedding_items.id`.

## Provider and Config

Embeddings should be optional and disabled by default:

```yaml
embeddings:
  enabled: false
  provider: openai
  model: text-embedding-3-small
  dimensions: 768
```

Reasons to keep this opt-in:

- API cost
- provider credentials
- source-code/privacy concerns
- extension packaging complexity
- reproducibility across machines and CI

## Query Flow

```text
query/context input
  -> embed query text if embeddings are enabled
  -> FTS candidates
  -> vector candidates
  -> hybrid rank merge
  -> metadata/status/severity boosts
  -> graph expansion
  -> context rendering
```

The ranking should expose diagnostics so users can see whether a result came from FTS, embeddings, graph expansion, or metadata boosts.

## Implementation Options

### Option A: Portable Fallback First

Store embeddings as JSON or BLOB values in SQLite and compute cosine similarity in the CLI process.

Pros:

- no SQLite extension required
- easiest to test
- works anywhere Node/Bun runs
- good enough for small repos

Cons:

- linear scan
- slower for large memory sets
- more application code

### Option B: SQLite Vector Extension

Use a vector extension such as `sqlite-vec` for KNN search inside SQLite.

Pros:

- better query performance
- keeps retrieval inside SQLite
- cleaner SQL query shape

Cons:

- extension packaging and loading complexity
- runtime compatibility risk
- harder install story across platforms

### Option C: External Vector Store

Use a separate vector database.

This should not be the default direction. It conflicts with the repo-local, single-file, easy-to-adopt design unless a future user need clearly justifies it.

## MVP Boundary

This is explicitly not part of MVP.

MVP should remain:

- canonical Markdown/YAML memory
- validation
- SQLite compile
- FTS query/show/system/context
- graph expansion
- coverage checks
- agent skills and manifests
- documentation and release flow

Embedding support should only be considered after the MVP retrieval flow has enough real usage to identify recall gaps that FTS, tags, indexes, and graph relationships do not solve.

## Acceptance Criteria for a Future Phase

If implemented later, embeddings should be considered complete when:

- embeddings are opt-in through config
- compile stores embedding metadata and vectors as generated cache
- unchanged artifacts are not re-embedded
- query/context can run hybrid FTS/vector retrieval
- results include retrieval diagnostics
- validation or doctor can report stale/missing embeddings
- the tool still works without credentials or vector extension support
- no canonical memory format depends on embeddings
