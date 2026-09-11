import type { MemoryClaim } from "./memory";

export interface ClaimQualitySignal {
  code: "GENERIC_SUMMARY" | "ID_ONLY_TAGS" | "VERIFICATION_METADATA_MISSING" | "SOURCE_CHANGED_SINCE_VERIFICATION";
  claimId: string;
  path: string;
  field: string;
  text: string | string[] | null;
  severity: "advisory";
}

/** Source-backed heuristics, never semantic validation or lifecycle changes. */
export function claimQualitySignals(claim: MemoryClaim): ClaimQualitySignal[] {
  const signal = (code: ClaimQualitySignal["code"], field: string, text: ClaimQualitySignal["text"]): ClaimQualitySignal =>
    ({ code, claimId: claim.id, path: claim.sourcePath, field, text, severity: "advisory" });
  return [
    ...(claim.claim.includes("preserves the documented data contract") ? [signal("GENERIC_SUMMARY", "claim", claim.claim)] : []),
    ...(claim.tags.length === 1 && claim.tags[0] === claim.id ? [signal("ID_ONLY_TAGS", "tags", claim.tags)] : []),
    ...(claim.raw.last_verified_commit == null ? [signal("VERIFICATION_METADATA_MISSING", "last_verified_commit", null)] : [])
  ];
}
