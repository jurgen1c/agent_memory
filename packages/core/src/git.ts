import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 10_000;
export const DEFAULT_GIT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

export interface GitCommandOptions {
  gitBinary?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  input?: string | Buffer;
  trim?: boolean;
}

export class GitCommandError extends Error {
  readonly timedOut: boolean;
  readonly status: number | null;

  constructor(message: string, options: { timedOut?: boolean; status?: number | null; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GitCommandError";
    this.timedOut = options.timedOut ?? false;
    this.status = options.status ?? null;
  }
}

export function isFullGitObjectId(value: string, expectedLength?: number): boolean {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) {
    return false;
  }

  return expectedLength === undefined || value.length === expectedLength;
}

export function repositoryObjectIdLength(repoRoot: string): 40 | 64 | undefined {
  const gitDirectory = resolveGitDirectory(repoRoot);

  if (!gitDirectory) {
    return undefined;
  }

  const commonDirectory = resolveCommonGitDirectory(gitDirectory);
  const configPath = path.join(commonDirectory, "config");

  if (!fs.existsSync(configPath)) {
    return 40;
  }

  const config = fs.readFileSync(configPath, "utf8");
  const repositoryFormatVersion = readGitConfigValue(config, "core", "repositoryformatversion");
  const objectFormat = readGitConfigValue(config, "extensions", "objectformat");
  return repositoryFormatVersion === "1" && objectFormat?.toLowerCase() === "sha256" ? 64 : 40;
}

export function runGit(repoRoot: string, args: string[], options: GitCommandOptions = {}): string {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
  const result = spawnSync(options.gitBinary ?? "git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER_BYTES,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL"
  });

  assertGitResult(result.error, result.status, result.stderr, args, timeoutMs);
  return options.trim === false ? result.stdout : result.stdout.trim();
}

export function runGitBuffer(
  repoRoot: string,
  args: string[],
  options: Omit<GitCommandOptions, "trim"> = {}
): Buffer {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
  const result = spawnSync(options.gitBinary ?? "git", args, {
    cwd: repoRoot,
    input: options.input,
    maxBuffer: options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER_BYTES,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL"
  });

  assertGitResult(result.error, result.status, result.stderr, args, timeoutMs);
  return result.stdout;
}

function assertGitResult(
  error: Error | undefined,
  status: number | null,
  stderr: string | Buffer,
  args: string[],
  timeoutMs: number
): void {
  const command = `git ${args.join(" ")}`;

  if (error) {
    const code = "code" in error ? error.code : undefined;

    if (code === "ETIMEDOUT") {
      throw new GitCommandError(`Git command timed out after ${timeoutMs}ms: ${command}`, {
        timedOut: true,
        status,
        cause: error
      });
    }

    throw new GitCommandError(`Could not start ${command}: ${error.message}`, { status, cause: error });
  }

  if (status !== 0) {
    const detail = stderr.toString().trim();
    throw new GitCommandError(
      `Git command exited with status ${status ?? "unknown"}: ${command}${detail ? `: ${detail}` : ""}`,
      { status }
    );
  }
}

function resolveGitDirectory(repoRoot: string): string | undefined {
  const gitPath = path.join(repoRoot, ".git");

  if (!fs.existsSync(gitPath)) {
    return undefined;
  }

  if (fs.statSync(gitPath).isDirectory()) {
    return gitPath;
  }

  const match = fs.readFileSync(gitPath, "utf8").match(/^gitdir:\s*(.+)\s*$/im);
  return match ? path.resolve(repoRoot, match[1]) : undefined;
}

function resolveCommonGitDirectory(gitDirectory: string): string {
  const commonDirectoryPath = path.join(gitDirectory, "commondir");

  if (!fs.existsSync(commonDirectoryPath)) {
    return gitDirectory;
  }

  return path.resolve(gitDirectory, fs.readFileSync(commonDirectoryPath, "utf8").trim());
}

function readGitConfigValue(content: string, sectionName: string, keyName: string): string | undefined {
  let currentSection = "";

  for (const line of content.split(/\r?\n/)) {
    const section = line.match(/^\s*\[\s*([^\s\]"]+)(\s+"[^"]*")?\s*\]/);

    if (section) {
      currentSection = section[2] ? "" : section[1].toLowerCase();
      continue;
    }

    if (currentSection !== sectionName.toLowerCase()) {
      continue;
    }

    const entry = line.match(/^\s*([^\s=]+)\s*=\s*(.*?)\s*$/);

    if (entry?.[1].toLowerCase() === keyName.toLowerCase()) {
      return normalizeGitConfigValue(entry[2]);
    }
  }

  return undefined;
}

function normalizeGitConfigValue(value: string): string {
  let normalized = "";
  let quoted = false;
  let escaped = false;

  for (const character of value.trim()) {
    if (escaped) {
      normalized += character;
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (character === '"') {
      quoted = !quoted;
      continue;
    }

    if (!quoted && (character === "#" || character === ";")) {
      break;
    }

    normalized += character;
  }

  return normalized.trim();
}
