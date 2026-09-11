/** Version 2 is an opt-in output API; the v1 context types remain unchanged. */
export type ContextOutputBudget = "small" | "medium" | "full";
export type ContextFacet = "category" | "tag" | "system" | "status";
export type ContextReasonCode = "EXACT_SOURCE" | "EXACT_SYMBOL" | "EXACT_ROUTE" | "TEXT_MATCH" | "RELATED_FILE" | "WATCHED_INDEX" | "FILTER_BROWSE" | "REQUIRED_DEPENDENCY" | "RELATED_CONTEXT" | "BASELINE_FALLBACK";
export interface ContextOutputFilters { categories?: string[]; tags?: string[]; systems?: string[]; statuses?: string[] }
export interface ContextOutputRequest {
  mode: "task" | "browse";
  budget?: ContextOutputBudget;
  maxBytes?: number;
  baseline?: boolean;
  filters?: ContextOutputFilters;
}
export interface ContextOutputReason { code: ContextReasonCode; outsideFilters: ContextFacet[] }
export interface ContextOutputSection { heading: string; occurrence?: number; startLine: number; text: string }
export interface ContextOutputEvidence {
  tier: number;
  textScore: number;
  matchedTokens: string[];
  fields: Array<{ field: string; section?: string; startLine?: number }>;
}
export interface ContextOutputClaim {
  id: string;
  sourcePath: string;
  title: string;
  claim: string;
  system: string;
  status: string;
  tags: string[];
  sections: ContextOutputSection[];
  body?: string;
  bodySha256?: string;
  metadata?: Record<string, ContextOutputData>;
  associations?: { files: string[]; symbols: string[]; routes: string[] };
}
export type ContextOutputData = null | boolean | number | string | ContextOutputData[] | { [key: string]: ContextOutputData };
/** Input order is the selector's ranking, never authored semantic authority. */
export interface ContextOutputRoot { claimId: string; reason: Exclude<ContextReasonCode, "REQUIRED_DEPENDENCY">; evidence?: ContextOutputEvidence }
export interface ContextOutputEdge {
  sourceClaimId: string;
  targetClaimId: string;
  relation: string;
  origin: "explicit" | "inferred";
  strength?: number;
}
export interface ContextOutputOwner { kind: "claim" | "recipe" | "plan" | "profile"; id: string; sourcePath: string }
export interface ContextOutputSuggestion { value: string; origins: ContextOutputOwner[] }
export interface ContextOutputCollectionItem {
  id: string;
  sourcePath: string;
  requiredClaimIds: string[];
  /** Required collections precede optional contributors for packing/suggestions. */
  required: boolean;
  data: Record<string, ContextOutputData>;
}
export interface ContextOutputCollection {
  totalEligible: number;
  matched: number;
  state: "empty" | "no_match" | "matched" | "not_requested";
  items: ContextOutputCollectionItem[];
}
export interface ContextOutputCandidates {
  roots: ContextOutputRoot[];
  claims: ContextOutputClaim[];
  edges?: ContextOutputEdge[];
  /** Authored collection or other explicit obligations, including missing IDs. */
  requiredClaimIds?: string[];
  files?: ContextOutputSuggestion[];
  commands?: ContextOutputSuggestion[];
  recipes?: ContextOutputCollection;
  plans?: ContextOutputCollection;
  profiles?: ContextOutputCollection;
}
export interface ContextOutputOmissions {
  claims: number; requiredClaims: number; edges: number; sections: number;
  files: number; commands: number; recipes: number; plans: number; profiles: number;
}
export interface ContextOutputModel {
  schemaVersion: 2;
  mode: "task" | "browse";
  filters: Required<ContextOutputFilters>;
  taskMatches: number;
  completeness: "complete" | "incomplete";
  roots: string[];
  claims: Array<ContextOutputClaim & { reasons: ContextOutputReason[]; evidence?: ContextOutputEvidence }>;
  edges: ContextOutputEdge[];
  files: ContextOutputSuggestion[];
  commands: Array<ContextOutputSuggestion & { state: "suggested_not_run" }>;
  recipes: ContextOutputCollection;
  plans: ContextOutputCollection;
  profiles: ContextOutputCollection;
  warnings: string[];
  budget: { maxBytes: number; usedBytes: number; omitted: ContextOutputOmissions };
}
export type ContextOutputErrorCode = "BUDGET_TOO_SMALL" | "UNKNOWN_CATEGORY" | "UNKNOWN_SYSTEM" | "UNKNOWN_STATUS" | "INPUT_REQUIRED" | "FORMAT_VERSION_REQUIRED" | "INVALID_INPUT" | "CLAIM_NOT_FOUND" | "CACHE_MISSING" | "VALIDATION_FAILED" | "CACHE_STALE" | "CACHE_SCHEMA_UNSUPPORTED";
export interface ContextOutputError { schemaVersion: 2; error: { code: ContextOutputErrorCode; message?: string } }
export type ContextOutputResult = { exitCode: 0; model: ContextOutputModel; stdout: string; stderr: string } | { exitCode: 2 | 3 | 4 | 5 | 7; model: ContextOutputError; stdout: string; stderr: string };
