import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalMemoryFileInventory } from "./files";
import type { AgentMemoryConfig } from "./types";

/** Digest configured canonical paths and bytes, including Markdown bodies. */
export function canonicalMemoryContentDigest(memoryRoot: string, config: AgentMemoryConfig): string {
  const inventory = canonicalMemoryFileInventory(memoryRoot, config);
  return crypto.createHash("sha256").update(JSON.stringify(inventory.map((relativePath) => [relativePath,
    crypto.createHash("sha256").update(fs.readFileSync(path.join(memoryRoot, relativePath))).digest("hex")]))).digest("hex");
}
