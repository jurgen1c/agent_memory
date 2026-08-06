import { spawnSync } from "node:child_process";

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

export function isFullGitObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
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
