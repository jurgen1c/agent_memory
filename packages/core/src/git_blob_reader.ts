import { AgentMemoryError } from "./errors";
import { GitCommandError, runGitBuffer } from "./git";

export const DEFAULT_GIT_BLOB_BATCH_TIMEOUT_MS = 5_000;

export interface ReadGitBlobsOptions {
  gitBinary?: string;
  timeoutMs?: number;
}

export function readGitBlobs(
  repoRoot: string,
  oids: string[],
  options: ReadGitBlobsOptions = {}
): Map<string, string> {
  const uniqueOids = Array.from(new Set(oids));

  if (uniqueOids.length === 0) {
    return new Map();
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_BLOB_BATCH_TIMEOUT_MS;
  let output: Buffer;

  try {
    output = runGitBuffer(repoRoot, ["cat-file", "--batch"], {
      gitBinary: options.gitBinary,
      input: `${uniqueOids.join("\n")}\n`,
      timeoutMs
    });
  } catch (error) {
    if (error instanceof GitCommandError && error.timedOut) {
      throw new AgentMemoryError(`Git audit baseline blob read timed out after ${timeoutMs}ms.`, {
        details: ["Audit will retain current-tree overlap findings when baseline blobs cannot be read."],
        cause: error
      });
    }

    throw new AgentMemoryError(`Git audit baseline blob reader failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }

  return parseGitBlobBatch(output, uniqueOids);
}

export function parseGitBlobBatch(output: Buffer, oids: string[]): Map<string, string> {
  const blobs = new Map<string, string>();
  let offset = 0;

  for (const oid of oids) {
    const headerEnd = output.indexOf(10, offset);

    if (headerEnd === -1) {
      throw new AgentMemoryError(`Could not read audit baseline blob ${oid}.`);
    }

    const header = output.subarray(offset, headerEnd).toString("utf8");
    const size = Number(header.split(" ")[2]);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;

    if (!Number.isSafeInteger(size) || size < 0 || contentEnd > output.length) {
      throw new AgentMemoryError(`Could not parse audit baseline blob ${oid}.`);
    }

    blobs.set(oid, output.subarray(contentStart, contentEnd).toString("utf8"));
    offset = contentEnd + 1;
  }

  return blobs;
}
