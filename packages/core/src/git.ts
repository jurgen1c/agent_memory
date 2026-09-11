import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
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
  spawn?: (binary: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;
}

export class GitCommandError extends Error {
  readonly timedOut: boolean;
  readonly status: number | null;
  readonly code?: string;
  readonly signal: string | null;
  readonly diagnostic: string;

  constructor(message: string, options: { timedOut?: boolean; status?: number | null; cause?: unknown; code?: string; signal?: string | null; diagnostic?: string } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GitCommandError";
    this.timedOut = options.timedOut ?? false;
    this.status = options.status ?? null;
    this.code = options.code;
    this.signal = options.signal ?? null;
    this.diagnostic = boundedGitDiagnostic(options.diagnostic ?? "");
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

export interface GitCommandResult {
  stdout: string;
  diagnostic: string;
  status: 0;
  signal: null;
  timedOut: false;
}

export function runGit(repoRoot: string, args: string[], options: GitCommandOptions = {}): string {
  return runGitResult(repoRoot, args, options).stdout;
}

export function runGitResult(repoRoot: string, args: string[], options: GitCommandOptions = {}): GitCommandResult {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
  const result = (options.spawn ?? spawnSync)(options.gitBinary ?? "git", args, {
    cwd: repoRoot,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER_BYTES,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL"
  });

  assertGitResult(result.error, result.status, result.stderr, args, timeoutMs, result.signal);
  return { stdout: options.trim === false ? result.stdout : result.stdout.trim(),
    diagnostic: boundedGitDiagnostic(result.stderr ?? ""), status: 0, signal: null, timedOut: false };
}

export function runGitBuffer(
  repoRoot: string,
  args: string[],
  options: Omit<GitCommandOptions, "trim" | "spawn"> = {}
): Buffer {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
  const result = spawnSync(options.gitBinary ?? "git", args, {
    cwd: repoRoot,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    input: options.input,
    maxBuffer: options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER_BYTES,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL"
  });

  assertGitResult(result.error, result.status, result.stderr, args, timeoutMs, result.signal);
  return result.stdout;
}

function assertGitResult(
  error: Error | undefined,
  status: number | null,
  stderr: string | Buffer,
  args: string[],
  timeoutMs: number,
  signal: string | null
): void {
  const command = `git ${args.join(" ")}`;

  if (error) {
    const code = "code" in error ? error.code : undefined;

    if (code === "ETIMEDOUT") {
      throw new GitCommandError(`Git command timed out after ${timeoutMs}ms: ${command}`, {
        timedOut: true,
        status,
        cause: error, code: String(code), signal, diagnostic: (stderr?.toString() ?? "")
      });
    }

    throw new GitCommandError(`Could not start ${command}: ${boundedGitDiagnostic(error.message)}`, { status, cause: error, code: typeof code === "string" ? code : undefined, signal, diagnostic: (stderr?.toString() ?? "") });
  }

  if (status !== 0 || signal) {
    const detail = boundedGitDiagnostic((stderr?.toString() ?? ""));
    throw new GitCommandError(
      `Git command exited with status ${status ?? "unknown"}: ${command}${detail ? `: ${detail}` : ""}`,
      { status, signal, diagnostic: detail }
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

export function boundedGitDiagnostic(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().slice(0, 512);
}
