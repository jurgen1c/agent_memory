import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgentMemoryError } from "./errors";
import { runGit } from "./git";

const MEMORY_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9_-])?$/;
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export interface DeriveInitMemoryKeyOptions {
  repoRoot: string;
  explicitMemoryKey?: string;
}

interface NormalizedRepositoryRemote {
  identity: string;
  repositoryPath: string;
}

export function deriveInitMemoryKey(options: DeriveInitMemoryKeyOptions): string {
  const explicit = options.explicitMemoryKey;
  const candidate = explicit ?? originRepositoryCandidate(options.repoRoot) ?? path.basename(options.repoRoot);
  const memoryKey = explicit === undefined ? slugifyMemoryKey(candidate) : candidate;

  if (!isValidMemoryKey(memoryKey)) {
    throw new AgentMemoryError("Could not derive a valid memory_key for global init.", {
      details: [
        "Pass --memory-key with 1-128 lowercase letters, digits, dots, underscores, or hyphens, starting with a letter or digit."
      ]
    });
  }

  return memoryKey;
}

export function isValidMemoryKey(value: string): boolean {
  const basename = value.split(".", 1)[0];
  return MEMORY_KEY_PATTERN.test(value) && !WINDOWS_DEVICE_NAME_PATTERN.test(basename);
}

export function slugifyMemoryKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function deriveRepositoryIdentity(repoRoot: string): string {
  let origin: string;

  try {
    origin = runGit(repoRoot, ["remote", "get-url", "origin"]);
  } catch {
    return `checkout:${checkoutIdentityDigest(repoRoot)}`;
  }

  const normalized = normalizeRepositoryRemote(origin);
  if (!normalized) {
    if (isLocalRepositoryRemote(origin)) {
      return `checkout:${checkoutIdentityDigest(repoRoot)}`;
    }
    throw new AgentMemoryError("Could not derive a safe repository identity for global storage.", {
      details: ["Use a supported credential-free origin URL or initialize with --local."]
    });
  }
  return normalized.identity;
}

function originRepositoryCandidate(repoRoot: string): string | undefined {
  let origin: string;

  try {
    origin = runGit(repoRoot, ["remote", "get-url", "origin"]);
  } catch {
    return undefined;
  }

  const normalized = normalizeRepositoryRemote(origin);
  return normalized?.repositoryPath.split("/").join("-");
}

function normalizeRepositoryRemote(remote: string): NormalizedRepositoryRemote | undefined {
  const urlRemote = repositoryRemoteFromUrl(remote);
  if (urlRemote) return urlRemote;

  const scpMatch = remote.match(/^([^@/:\s]+)@([^/:\s]+):(.+)$/);
  if (!scpMatch) return undefined;
  return normalizedRemote(scpMatch[2], scpMatch[3], scpMatch[1], true);
}

function repositoryRemoteFromUrl(remote: string): NormalizedRepositoryRemote | undefined {
  let parsed: URL;

  try {
    parsed = new URL(remote);
  } catch {
    return undefined;
  }

  if (
    !["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)
    || !parsed.hostname
    || hasUnsafeUrlPathSegments(remote)
    || !isDefaultRemotePort(parsed.protocol, parsed.port)
  ) {
    return undefined;
  }

  return normalizedRemote(parsed.hostname, parsed.pathname, parsed.username || undefined, parsed.protocol === "ssh:");
}

function normalizedRemote(
  rawHost: string,
  rawRepositoryPath: string,
  sshAccount: string | undefined,
  sshTransport: boolean
): NormalizedRepositoryRemote | undefined {
  const host = rawHost.toLowerCase();
  const parsedRepositoryPath = normalizeRepositoryPath(rawRepositoryPath);
  const repositoryPath = parsedRepositoryPath && isCaseInsensitiveRepositoryHost(host)
    ? parsedRepositoryPath.toLowerCase()
    : parsedRepositoryPath;
  if (
    !repositoryPath
    || !/^[A-Za-z0-9._~/-]+$/.test(repositoryPath)
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)
    || host.includes("..")
  ) {
    return undefined;
  }

  const account = sshTransport && !isTransportOnlySshAccount(host, sshAccount)
    ? sshAccount && /^[A-Za-z0-9._-]+$/.test(sshAccount)
      ? `ssh-account:${sshAccount}@`
      : undefined
    : "";
  if (account === undefined) return undefined;

  return {
    identity: `remote:${account}${host}/${repositoryPath}`,
    repositoryPath
  };
}

function normalizeRepositoryPath(repositoryPath: string): string | undefined {
  const withoutQuery = repositoryPath.split(/[?#]/, 1)[0];
  const segments = withoutQuery
    .replace(/^\/+|\/+$/g, "")
    .split("/");

  if (segments.some((segment) => segment === "." || segment === "..")) return undefined;
  const nonEmptySegments = segments.filter((segment) => segment.length > 0);

  if (nonEmptySegments.length === 0) return undefined;
  nonEmptySegments[nonEmptySegments.length - 1] = nonEmptySegments.at(-1)?.replace(/\.git$/i, "") ?? "";
  return nonEmptySegments.at(-1)?.length ? nonEmptySegments.join("/") : undefined;
}

function isTransportOnlySshAccount(host: string, account: string | undefined): boolean {
  return account === "git" && ["github.com", "gitlab.com", "bitbucket.org"].includes(host);
}

function isCaseInsensitiveRepositoryHost(host: string): boolean {
  return ["github.com", "gitlab.com", "bitbucket.org"].includes(host);
}

function isLocalRepositoryRemote(remote: string): boolean {
  return remote.startsWith("file://")
    || path.isAbsolute(remote)
    || /^(?:\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(remote)
    || (remote.length > 0 && !remote.includes(":") && !remote.includes("\0"));
}

function isDefaultRemotePort(protocol: string, port: string): boolean {
  if (!port) return true;
  return (protocol === "ssh:" && port === "22") || (protocol === "git:" && port === "9418");
}

function hasUnsafeUrlPathSegments(remote: string): boolean {
  const withoutSuffix = remote.split(/[?#]/, 1)[0];
  const schemeEnd = withoutSuffix.indexOf("://");
  const pathStart = schemeEnd < 0 ? -1 : withoutSuffix.indexOf("/", schemeEnd + 3);
  if (pathStart < 0) return false;

  return withoutSuffix
    .slice(pathStart)
    .split("/")
    .some((segment) => {
      try {
        const decoded = decodeURIComponent(segment);
        return decoded === "." || decoded === "..";
      } catch {
        return true;
      }
    });
}

function checkoutIdentityDigest(repoRoot: string): string {
  let identityPath = repoRoot;

  try {
    identityPath = runGit(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  } catch {
    // A repository root is the documented fallback when the common directory is unavailable.
  }

  const canonicalPath = fs.realpathSync(path.resolve(repoRoot, identityPath));
  return crypto.createHash("sha256").update(canonicalPath, "utf8").digest("hex");
}
