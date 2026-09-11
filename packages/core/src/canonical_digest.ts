import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { discoverCanonicalMemoryFiles, resolveConfiguredPath, toPosix } from "./files";
import type { LoadedConfig } from "./types";

/** One digest seam shared by compilation, retrieval, and future cache-health inspection. */
export function canonicalContentDigest(loaded: LoadedConfig): string {
  const root = resolveConfiguredPath(loaded.repo.root, loaded.config.memory_root);
  const hash = crypto.createHash("sha256");
  const add = (name: string, bytes: Buffer) => {
    hash.update(JSON.stringify([name, bytes.length])).update("\0").update(bytes).update("\0");
  };
  add("config", fs.readFileSync(loaded.path));
  for (const file of [...new Set(discoverCanonicalMemoryFiles(root, loaded.config))]) add(toPosix(path.relative(root, file)), fs.readFileSync(file));
  return hash.digest("hex");
}
