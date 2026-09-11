import fs from "node:fs";
import path from "node:path";
import { canonicalContentDigest } from "./canonical_digest";
import { normalizeChangedFiles } from "./changes";
import { claimBodyDigest } from "./claim_sections";
import { loadConfig } from "./config";
import { assertGlobalDatabaseProvenance, resolveConfiguredDatabaseLocation } from "./database";
import { resolveConfiguredPath, toPosix } from "./files";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite";
import type { ContextOutputClaim, ContextOutputData, ContextOutputEdge, ContextOutputErrorCode } from "./context_output_types";
import { validateRepository } from "./validator";
import type { LoadedConfig } from "./types";

export class RetrievalV2Error extends Error {
  constructor(readonly code: ContextOutputErrorCode, message: string) { super(message); }
}
export interface CachedClaim extends ContextOutputClaim { memoryPath: string; relatedFiles: string[]; verification: string[] }
export interface RetrievalCache {
  loaded: LoadedConfig;
  claims: CachedClaim[];
  edges: ContextOutputEdge[];
  indexes: Array<{ watched_files?: string[]; claim_globs?: string[] }>;
  terms: Array<{ claim_id: string; field: string; section_ordinal: number; token: string }>;
}

export async function readRetrievalCache(cwd?: string): Promise<RetrievalCache> {
  const loaded = loadConfig({ cwd });
  const location = resolveConfiguredDatabaseLocation({ loaded });
  if (!fs.existsSync(location.path)) throw new RetrievalV2Error("CACHE_MISSING", "Run agent-memory compile in this checkout first.");
  const database = await openSqliteDatabase(location.path, { readonly: true });
  try {
    let metadata: Map<string, string>;
    try { metadata = new Map(database.all<{ key: string; value: string }>("SELECT key, value FROM compile_metadata").map(row => [row.key, row.value])); }
    catch { throw new RetrievalV2Error("CACHE_SCHEMA_UNSUPPORTED", "Unrecognized cache. Run agent-memory compile."); }
    if (metadata.get("schema_version") !== "2") throw new RetrievalV2Error("CACHE_SCHEMA_UNSUPPORTED", "Schema 2 is required. Run agent-memory compile; rollback requires recompilation with the prior package.");
    try { assertGlobalDatabaseProvenance(database, location, loaded); }
    catch { throw new RetrievalV2Error("CACHE_STALE", "Cache provenance differs from this checkout. Run agent-memory compile."); }
    if (fs.realpathSync(loaded.repo.root) !== metadata.get("repo_root") || metadata.get("canonical_content_hash") !== canonicalContentDigest(loaded)) throw new RetrievalV2Error("CACHE_STALE", "Canonical memory or checkout changed. Run agent-memory compile.");
    const validation = validateRepository({ cwd });
    if (!validation.valid) throw new RetrievalV2Error("VALIDATION_FAILED", "Canonical memory or source associations are invalid. Run agent-memory validate.");
    const claims = hydrateClaims(database, loaded);
    const edges = database.all<ContextOutputEdge>(`SELECT source_claim_id AS sourceClaimId, target_claim_id AS targetClaimId, relation, origin, strength FROM claim_relations WHERE origin IN ('explicit', 'inferred') ORDER BY strength DESC, source_claim_id, target_claim_id, relation, origin`);
    const indexes = database.all<{ metadata_json: string }>("SELECT metadata_json FROM indexes ORDER BY id").map(row => JSON.parse(row.metadata_json));
    const terms = database.all<RetrievalCache["terms"][number]>("SELECT claim_id, field, section_ordinal, token FROM claim_terms ORDER BY token, claim_id, field, section_ordinal");
    if (metadata.get("canonical_content_hash") !== canonicalContentDigest(loaded)) throw new RetrievalV2Error("CACHE_STALE", "Canonical memory changed while retrieving. Retry after compiling.");
    return { loaded, claims, edges, indexes, terms };
  } finally { database.close(); }
}

function hydrateClaims(database: SqliteDatabase, loaded: LoadedConfig): CachedClaim[] {
  const memoryRoot = resolveConfiguredPath(loaded.repo.root, loaded.config.memory_root);
  const records = database.all<{ id: string; title: string; claim: string; system: string; status: string; source_path: string; metadata_json: string; body: string; body_sha256: string }>("SELECT c.*, b.body, b.body_sha256 FROM claims c JOIN claim_bodies b ON b.claim_id = c.id ORDER BY c.id");
  if (records.length !== database.get<{ count: number }>("SELECT count(*) AS count FROM claims")?.count) throw new RetrievalV2Error("CACHE_STALE", "Cache is missing claim bodies. Recompile.");
  return records.map(row => {
    if (claimBodyDigest(row.body) !== row.body_sha256) throw new RetrievalV2Error("CACHE_STALE", "Cached body digest differs. Recompile.");
    const metadata = JSON.parse(row.metadata_json) as Record<string, ContextOutputData>;
    const strings = (key: string) => Array.isArray(metadata[key]) ? metadata[key].filter((value): value is string => typeof value === "string") : [];
    return {
      id: row.id, title: row.title, claim: row.claim, system: row.system, status: row.status,
      sourcePath: toPosix(path.relative(loaded.repo.root, path.join(memoryRoot, row.source_path))), memoryPath: row.source_path,
      body: row.body, bodySha256: row.body_sha256, cacheFreshness: "current", metadata, tags: strings("tags"),
      associations: { files: normalizeChangedFiles(strings("source_files"), loaded.repo.root), symbols: strings("symbols"), routes: strings("routes") },
      relatedFiles: normalizeChangedFiles(strings("related_files"), loaded.repo.root), verification: strings("verification"),
      sections: database.all("SELECT heading, occurrence, start_line AS startLine, text FROM claim_sections WHERE claim_id = ? ORDER BY ordinal", [row.id])
    };
  });
}
