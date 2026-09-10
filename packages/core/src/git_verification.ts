import fs from "node:fs";
import path from "node:path";
import { boundedGitDiagnostic, GitCommandError, isFullGitObjectId, runGitResult, type GitCommandOptions } from "./git";

export type VerificationCheckState = "verified" | "invalid_reference" | "unavailable" | "not_run";
export type GitVerificationCode = "GIT_PERMISSION_DENIED" | "GIT_EXECUTABLE_MISSING" | "GIT_TIMEOUT" |
  "GIT_UNAVAILABLE" | "GIT_CHECK_FAILED" | "GIT_UNKNOWN_OBJECT" | "GIT_VERIFIED" | "VERIFICATION_METADATA_MALFORMED";
export interface GitVerificationDiagnostic {
  code: GitVerificationCode;
  state: VerificationCheckState;
  message: string;
  remediation: string;
  errorCode?: string;
  phase?: "repository" | "object";
  status: number | null;
  signal: string | null;
  timedOut: boolean;
  diagnostic: string;
}

export function gitFailureDiagnostic(error: unknown): GitVerificationDiagnostic {
  const command = error instanceof GitCommandError ? error : undefined;
  const errorCode = command?.code ?? (error && typeof error === "object" && "code" in error ? typeof error.code === "string" ? error.code : undefined : undefined);
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
  return createGitCommitVerifier(repoRoot, options)(reference);
}

/** Reuses one accessible-store preflight for a read-only audit invocation. */
export function createGitCommitVerifier(repoRoot: string, options: GitCommandOptions = {}): (reference: string) => GitVerificationDiagnostic {
  let preparation: 40 | 64 | GitVerificationDiagnostic | undefined;
  const probe = (args: string[], extra: GitCommandOptions = {}): string => {
    const result = runGitResult(repoRoot, args, { ...options, ...extra });
    // Even status-zero Git probes report damaged packs on stderr. Any diagnostic
    // makes a missing-object conclusion unsafe; do not parse localized messages.
    if (result.diagnostic) throw new GitCommandError("Git reported diagnostics while inspecting the repository object store.",
      { status: result.status, diagnostic: result.diagnostic });
    return result.stdout;
  };
  const outcome = (code: GitVerificationCode, state: VerificationCheckState, message: string, remediation: string): GitVerificationDiagnostic =>
    ({ code, state, message, remediation, status: 0, signal: null, timedOut: false, diagnostic: "" });
  const malformed = () => outcome("VERIFICATION_METADATA_MALFORMED", "invalid_reference",
    "Verification metadata or Git output does not identify the exact full commit object.",
    "Review the recorded metadata and Git output; retain the recorded value until reviewed.");
  return (reference) => {
    reference = reference.trim();
    if (!isFullGitObjectId(reference)) return malformed();
    try {
      if (preparation === undefined) {
        try {
          fs.accessSync(repoRoot, fs.constants.R_OK | fs.constants.X_OK);
          if (!fs.statSync(repoRoot).isDirectory()) throw new GitCommandError("Repository path is not a directory.", { status: 0 });
          const format = probe(["rev-parse", "--show-object-format"]);
          if (format !== "sha1" && format !== "sha256") throw new GitCommandError("Git returned an unsupported repository object format.", { status: 0 });
          const objectPath = probe(["rev-parse", "--git-path", "objects"]);
          if (!objectPath || objectPath.includes("\n")) throw new GitCommandError("Git returned an invalid object-store path.", { status: 0 });
          const visited = new Set<string>();
          assertObjectStoreAccessible(path.resolve(repoRoot, objectPath), visited);
          const inventory = probe(["count-objects", "-v"]);
          // Git resolves file comments, quoted paths, nested alternates and environment
          // alternates itself. Its output C-quotes paths, including embedded newlines.
          for (const line of inventory.split("\n")) {
            if (line.startsWith("alternate: ")) {
              assertObjectStoreAccessible(path.resolve(repoRoot, decodeAlternatePath(line.slice("alternate: ".length))), visited);
            }
          }
          preparation = format === "sha1" ? 40 : 64;
        } catch (error) { preparation = { ...gitFailureDiagnostic(error), phase: "repository" }; }
      }
      if (typeof preparation !== "number") return preparation;
      if (!isFullGitObjectId(reference, preparation)) return malformed();
      const oid = reference.toLowerCase();
      const output = probe(["--no-replace-objects", "cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: `${oid}\n`, trim: false });
      if (output === `${oid} missing\n`) return outcome("GIT_UNKNOWN_OBJECT", "invalid_reference",
        "The accessible Git object store explicitly reports the recorded commit is missing.",
        "Inspect fetch and history, then repair the reference only after review.");
      if (output !== `${oid} commit\n`) return malformed();
      return outcome("GIT_VERIFIED", "verified", "The exact recorded commit object resolves; claim truth and verification commands were not checked.", "No reference repair needed.");
    } catch (error) { return { ...gitFailureDiagnostic(error), phase: "object" }; }
  };
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

}

// Git alternate files use C-style quoting, including octal UTF-8 bytes.
function decodeAlternatePath(value: string): string {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) throw new GitCommandError("Malformed quoted Git alternate path.", { status: 0 });
  const bytes: Buffer[] = [];
  const escapes: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", '\\': '\\', '"': '"' };
  for (let index = 1; index < value.length - 1; index++) {
    if (value[index] !== "\\") {
      const point = value.codePointAt(index)!;
      bytes.push(Buffer.from(String.fromCodePoint(point)));
      if (point > 0xffff) index++;
      continue;
    }
    const escape = value[++index];
    const octal = value.slice(index, index + 3);
    if (/^[0-3][0-7]{2}$/.test(octal)) {
      bytes.push(Buffer.from([parseInt(octal, 8)])); index += 2;
    } else if (Object.hasOwn(escapes, escape)) bytes.push(Buffer.from(escapes[escape]));
    else throw new GitCommandError("Unsupported escape in Git alternate path.", { status: 0 });
  }
  return Buffer.concat(bytes).toString("utf8");
}
