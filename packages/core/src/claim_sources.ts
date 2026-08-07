import fs from "node:fs";
import path from "node:path";
import { pathMatchesPattern, toPosix } from "./files";
import { isPathInside } from "./repo";
import type { ClaimSourcePolicy } from "./types";

export type ClaimSourcePolicyReason = "allowed" | "denied" | "not_allowed";

export interface ClaimSourcePolicyDecision {
  eligible: boolean;
  reason: ClaimSourcePolicyReason;
  pattern?: string;
  resolvedPath?: string;
}

export function evaluateClaimSourcePath(
  filePath: string,
  policy: ClaimSourcePolicy,
  repoRoot?: string
): ClaimSourcePolicyDecision {
  const paths = claimSourcePathCandidates(filePath, repoRoot);

  for (const candidate of paths) {
    const deniedBy = policy.deny.find((pattern) => pathMatchesPattern(pattern, candidate));

    if (deniedBy) {
      return {
        eligible: false,
        reason: "denied",
        pattern: deniedBy,
        ...(candidate === paths[0] ? {} : { resolvedPath: candidate })
      };
    }
  }

  if (policy.allow.length === 0) {
    return { eligible: true, reason: "allowed" };
  }

  for (const candidate of paths) {
    const allowedBy = policy.allow.find((pattern) => pathMatchesPattern(pattern, candidate));

    if (!allowedBy) {
      return {
        eligible: false,
        reason: "not_allowed",
        ...(candidate === paths[0] ? {} : { resolvedPath: candidate })
      };
    }
  }

  const allowedBy = policy.allow.find((pattern) => pathMatchesPattern(pattern, paths[0]));
  return { eligible: true, reason: "allowed", pattern: allowedBy };
}

export function describeClaimSourcePolicyDecision(filePath: string, decision: ClaimSourcePolicyDecision): string {
  const resolvedDetail = decision.resolvedPath ? ` (resolved target ${decision.resolvedPath})` : "";

  if (decision.reason === "denied") {
    return `Claim source path ${filePath}${resolvedDetail} is denied by claim_sources.deny pattern ${decision.pattern}.`;
  }

  if (decision.reason === "not_allowed") {
    return `Claim source path ${filePath}${resolvedDetail} does not match any claim_sources.allow pattern.`;
  }

  return `Claim source path ${filePath} is allowed.`;
}

export function renderClaimSourcePolicy(policy: ClaimSourcePolicy): string {
  const allow =
    policy.allow.length > 0 ? policy.allow.map(renderMarkdownCodeSpan).join(", ") : "all repository paths";
  const deny = policy.deny.length > 0 ? policy.deny.map(renderMarkdownCodeSpan).join(", ") : "none";

  return `- Allowed claim sources: ${allow}
- Denied claim sources: ${deny}`;
}

function renderMarkdownCodeSpan(value: string): string {
  const singleLine = value.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
  const longestBacktickRun = Math.max(0, ...Array.from(singleLine.matchAll(/`+/g), (match) => match[0].length));
  const delimiter = "`".repeat(longestBacktickRun + 1);
  const needsPadding = /^[ `]|[ `]$/.test(singleLine);
  const padding = needsPadding ? " " : "";

  return `${delimiter}${padding}${singleLine}${padding}${delimiter}`;
}

export function normalizeClaimSourcePath(filePath: string): string {
  const normalizedSeparators = toPosix(filePath).replaceAll("\\", "/");
  const normalizedSegments = path.posix.normalize(normalizedSeparators);
  return normalizedSegments === "." ? "" : normalizedSegments.replace(/^(?:\.\/)+/, "");
}

export function claimSourcePathCandidates(filePath: string, repoRoot?: string): string[] {
  const lexicalPath = normalizeClaimSourcePath(filePath);

  if (!repoRoot || lexicalPath.length === 0) {
    return [lexicalPath];
  }

  try {
    const lexicalRepoRoot = path.resolve(repoRoot);
    const absoluteSourcePath = path.resolve(lexicalRepoRoot, lexicalPath);

    if (!pathIsInsideOrEqual(lexicalRepoRoot, absoluteSourcePath)) {
      return [lexicalPath];
    }

    let existingAncestor = absoluteSourcePath;

    while (!fs.existsSync(existingAncestor)) {
      const parent = path.dirname(existingAncestor);

      if (parent === existingAncestor || !pathIsInsideOrEqual(lexicalRepoRoot, parent)) {
        return [lexicalPath];
      }

      existingAncestor = parent;
    }

    const realRepoRoot = fs.realpathSync(lexicalRepoRoot);
    const unresolvedSuffix = path.relative(existingAncestor, absoluteSourcePath);
    const realSourcePath = path.resolve(fs.realpathSync(existingAncestor), unresolvedSuffix);

    if (!pathIsInsideOrEqual(realRepoRoot, realSourcePath)) {
      return [lexicalPath];
    }

    const resolvedPath = normalizeClaimSourcePath(path.relative(realRepoRoot, realSourcePath));
    return resolvedPath === lexicalPath ? [lexicalPath] : [lexicalPath, resolvedPath];
  } catch {
    return [lexicalPath];
  }
}

function pathIsInsideOrEqual(root: string, candidate: string): boolean {
  return path.resolve(root) === path.resolve(candidate) || isPathInside(root, candidate);
}
