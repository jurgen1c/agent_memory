import path from "node:path";
import { pathMatchesPattern, toPosix } from "./files";
import type { ClaimSourcePolicy } from "./types";

export type ClaimSourcePolicyReason = "allowed" | "denied" | "not_allowed";

export interface ClaimSourcePolicyDecision {
  eligible: boolean;
  reason: ClaimSourcePolicyReason;
  pattern?: string;
}

export function evaluateClaimSourcePath(filePath: string, policy: ClaimSourcePolicy): ClaimSourcePolicyDecision {
  const normalizedPath = normalizeClaimSourcePath(filePath);
  const deniedBy = policy.deny.find((pattern) => pathMatchesPattern(pattern, normalizedPath));

  if (deniedBy) {
    return {
      eligible: false,
      reason: "denied",
      pattern: deniedBy
    };
  }

  if (policy.allow.length === 0) {
    return { eligible: true, reason: "allowed" };
  }

  const allowedBy = policy.allow.find((pattern) => pathMatchesPattern(pattern, normalizedPath));

  if (allowedBy) {
    return {
      eligible: true,
      reason: "allowed",
      pattern: allowedBy
    };
  }

  return { eligible: false, reason: "not_allowed" };
}

export function describeClaimSourcePolicyDecision(filePath: string, decision: ClaimSourcePolicyDecision): string {
  if (decision.reason === "denied") {
    return `Claim source path ${filePath} is denied by claim_sources.deny pattern ${decision.pattern}.`;
  }

  if (decision.reason === "not_allowed") {
    return `Claim source path ${filePath} does not match any claim_sources.allow pattern.`;
  }

  return `Claim source path ${filePath} is allowed.`;
}

function normalizeClaimSourcePath(filePath: string): string {
  const normalizedSeparators = toPosix(filePath).replaceAll("\\", "/");
  const normalizedSegments = path.posix.normalize(normalizedSeparators);
  return normalizedSegments === "." ? "" : normalizedSegments.replace(/^(?:\.\/)+/, "");
}
