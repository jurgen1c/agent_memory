import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "agent-memory";
export const PACKAGE_VERSION = readPackageVersion();

function readPackageVersion(): string {
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const entryDir = path.dirname(process.argv[1] ?? "");
  const candidates = [
    path.resolve(sourceDir, "../../../package.json"),
    path.resolve(entryDir, "../package.json")
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { version?: unknown };

      if (typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }

      throw error;
    }
  }

  throw new Error("Unable to read agent-memory package version.");
}
