import fs from "node:fs";
import path from "node:path";
import { boundedGitDiagnostic, GitCommandError, isFullGitObjectId, runGit, type GitCommandOptions } from "./git";

export type VerificationCheckState = "verified" | "invalid_reference" | "unavailable" | "not_run";
export type GitVerificationCode = "GIT_PERMISSION_DENIED" | "GIT_EXECUTABLE_MISSING" | "GIT_TIMEOUT" |
  "GIT_UNAVAILABLE" | "GIT_CHECK_FAILED" | "GIT_UNKNOWN_OBJECT" | "GIT_VERIFIED" | "VERIFICATION_METADATA_MALFORMED";
export interface GitVerificationDiagnostic {
  code: GitVerificationCode;
  state: VerificationCheckState;
  message: string;
  remediation: string;
  errorCode?: string;
  status: number | null;
  signal: string | null;
  timedOut: boolean;
  diagnostic: string;
}

export function gitFailureDiagnostic(error: unknown): GitVerificationDiagnostic {
  const command = error instanceof GitCommandError ? error : undefined;
  const errorCode = command?.code ?? (error && typeof error === "object" && "code" in error ? String(error.code) : undefined);
  const code = errorCode === "EPERM" || errorCode === "EACCES" ? "GIT_PERMISSION_DENIED"
    : errorCode === "ETIMEDOUT" || command?.timedOut ? "GIT_TIMEOUT"
    : errorCode === "ENOENT" && command ? "GIT_EXECUTABLE_MISSING"
    : command && (command.cause || command.signal || command.status === null) ? "GIT_UNAVAILABLE"
    : "GIT_CHECK_FAILED";
  const remediation = code === "GIT_PERMISSION_DENIED" ? "Allow Git subprocess and repository access, then rerun; retain commit IDs."
    : code === "GIT_EXECUTABLE_MISSING" ? "Install or configure Git, then rerun; retain commit IDs."
    : code === "GIT_TIMEOUT" ? "Retry with an allowed higher Git timeout; retain commit IDs."
    : code === "GIT_UNAVAILABLE" ? "Inspect the execution environment and rerun; retain commit IDs."
    : "Restore repository and object-store access or integrity, then rerun; retain commit IDs.";
  return { code, state: "unavailable", message: boundedGitDiagnostic(error instanceof Error ? error.message : String(error)),
    remediation, errorCode, status: command?.status ?? null, signal: command?.signal ?? null,
    timedOut: command?.timedOut ?? errorCode === "ETIMEDOUT", diagnostic: command?.diagnostic ?? "" };
}

/** Resolves only exact immutable commit objects. Never executes stored verification commands. */
export function verifyGitCommit(repoRoot: string, reference: string, options: GitCommandOptions = {}): GitVerificationDiagnostic {
  const outcome = (code: GitVerificationCode, state: VerificationCheckState, message: string, remediation: string): GitVerificationDiagnostic =>
    ({ code, state, message, remediation, status: 0, signal: null, timedOut: false, diagnostic: "" });
  const malformed = () => outcome("VERIFICATION_METADATA_MALFORMED", "invalid_reference",
    "Verification metadata or Git output does not identify the exact full commit object.",
    "Review the recorded metadata and Git output; retain the recorded value until reviewed.");
  if (!isFullGitObjectId(reference)) return malformed();
  try {
    const format = runGit(repoRoot, ["rev-parse", "--show-object-format"], options);
    if (format !== "sha1" && format !== "sha256") throw new GitCommandError("Git returned an unsupported repository object format.", { status: 0 });
    const objectPath = runGit(repoRoot, ["rev-parse", "--git-path", "objects"], options);
    if (!objectPath || objectPath.includes("\n")) throw new GitCommandError("Git returned an invalid object-store path.", { status: 0 });
    assertObjectStoreAccessible(path.resolve(repoRoot, objectPath));
    runGit(repoRoot, ["count-objects", "-v"], options);
    if (!isFullGitObjectId(reference, format === "sha1" ? 40 : 64)) return malformed();
    const oid = reference.toLowerCase();
    const output = runGit(repoRoot, ["--no-replace-objects", "cat-file", "--batch-check=%(objectname) %(objecttype)"], { ...options, input: `${oid}\n`, trim: false });
    if (output === `${oid} missing\n`) return outcome("GIT_UNKNOWN_OBJECT", "invalid_reference",
      "The accessible Git object store explicitly reports the recorded commit is missing.",
      "Inspect fetch and history, then repair the reference only after review.");
    if (output !== `${oid} commit\n`) return malformed();
    return outcome("GIT_VERIFIED", "verified", "The exact recorded commit object resolves; claim truth and verification commands were not checked.", "No reference repair needed.");
  } catch (error) {
    return gitFailureDiagnostic(error);
  }
}

// Git can report inaccessible loose objects as missing. Check every local and alternate
// store before trusting that result; reading directory entries does not read object content.
function assertObjectStoreAccessible(root: string, visited = new Set<string>()): void {
  const real = fs.realpathSync(root);
  if (visited.has(real)) return;
  visited.add(real);
  fs.accessSync(real, fs.constants.R_OK | fs.constants.X_OK);
  for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
    const target = path.join(real, entry.name);
    if (fs.statSync(target).isDirectory()) assertObjectStoreAccessible(target, visited);
    else fs.accessSync(target, fs.constants.R_OK);
  }
  const alternates = path.join(real, "info", "alternates");
  if (fs.existsSync(alternates)) {
    for (const alternate of fs.readFileSync(alternates, "utf8").split(/\r?\n/).filter(Boolean)) {
      assertObjectStoreAccessible(path.resolve(real, alternate), visited);
    }
  }
}
