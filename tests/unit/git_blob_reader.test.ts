import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGitBlobBatch, readGitBlobs } from "../../packages/core/src/git_blob_reader";

describe("Git blob batch reader", () => {
  test("parses multiple binary-safe batch entries", () => {
    const firstOid = "1111111111111111111111111111111111111111";
    const secondOid = "2222222222222222222222222222222222222222";
    const first = "alpha";
    const second = "line one\nline two";
    const output = Buffer.concat([
      Buffer.from(`${firstOid} blob ${Buffer.byteLength(first)}\n${first}\n`),
      Buffer.from(`${secondOid} blob ${Buffer.byteLength(second)}\n${second}\n`)
    ]);

    expect(parseGitBlobBatch(output, [firstOid, secondOid])).toEqual(
      new Map([
        [firstOid, first],
        [secondOid, second]
      ])
    );
  });

  test("rejects malformed batch output", () => {
    expect(() => parseGitBlobBatch(Buffer.from("broken\n"), ["missing"])).toThrow(
      "Could not parse audit baseline blob missing"
    );
  });

  test("terminates a stalled Git blob subprocess after the configured timeout", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-git-blob-timeout-"));
    const gitBinary = path.join(repoRoot, "stalled-git");
    fs.writeFileSync(gitBinary, "#!/usr/bin/env bash\nwhile true; do :; done\n");
    fs.chmodSync(gitBinary, 0o755);
    const startedAt = performance.now();

    expect(() => readGitBlobs(repoRoot, ["1111111111111111111111111111111111111111"], { gitBinary, timeoutMs: 50 })).toThrow(
      "Git audit baseline blob read timed out after 50ms"
    );
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
