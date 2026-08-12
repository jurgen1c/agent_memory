import { inspectFileSystemPathSync } from "@jurgen1c/agent-core/filesystem";
import { resolveContainedPath } from "@jurgen1c/agent-core/repository";
import path from "node:path";
import { loadConfig } from "./config";
import type { RegistryCheckoutRecord } from "./registry";

export type RegistryCheckoutMappingInspection =
  | { status: "active" }
  | { status: "stale" }
  | { status: "inconclusive"; message: string };

type PathInspection =
  | { status: "present" }
  | { status: "missing" }
  | { status: "inconclusive"; message: string };

export function inspectRegistryCheckoutMapping(
  memoryKey: string,
  checkout: RegistryCheckoutRecord
): RegistryCheckoutMappingInspection {
  const repoRoot = inspectPath(checkout.repo_root);
  if (repoRoot.status === "missing") return { status: "stale" };
  if (repoRoot.status === "inconclusive") return repoRoot;

  const configPathInspection = inspectPath(checkout.config_path);
  if (configPathInspection.status === "missing") return { status: "stale" };
  if (configPathInspection.status === "inconclusive") return configPathInspection;

  try {
    const containedConfigPath = resolveContainedPath(checkout.repo_root, checkout.config_path).absolutePath;
    const configPath = path.relative(checkout.repo_root, containedConfigPath);
    const loaded = loadConfig({ repoRoot: checkout.repo_root, configPath });
    return loaded.config.database_scope === "global" && loaded.config.memory_key === memoryKey
      ? { status: "active" }
      : { status: "stale" };
  } catch (error) {
    return {
      status: "inconclusive",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function inspectPath(filePath: string): PathInspection {
  const inspection = inspectFileSystemPathSync(filePath);
  if (inspection.status !== "inconclusive") return inspection;
  return {
    status: "inconclusive",
    message: `Could not inspect ${filePath}: ${inspection.error instanceof Error ? inspection.error.message : String(inspection.error)}`
  };
}
