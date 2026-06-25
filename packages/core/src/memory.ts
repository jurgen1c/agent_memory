import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { discoverFiles } from "./files";
import { parseMarkdownFile } from "./markdown";
import type { LoadedConfig } from "./types";
import { parseYaml } from "./yaml";

export interface MemoryClaim {
  id: string;
  type: string;
  system: string;
  status: string;
  confidence: string;
  severity: string;
  title: string;
  claim: string;
  sourcePath: string;
  sourceFiles: string[];
  relatedFiles: string[];
  symbols: string[];
  routes: string[];
  tags: string[];
  verification: string[];
  raw: Record<string, unknown>;
}

export interface MemoryGraph {
  id: string;
  name: string;
  sourcePath: string;
  edges: MemoryGraphEdge[];
  raw: Record<string, unknown>;
}

export interface MemoryGraphEdge {
  source?: string;
  target?: string;
  claims?: string[];
  relation: string;
  reason?: string;
  strength: number;
  bidirectional: boolean;
  raw: Record<string, unknown>;
}

export interface MemoryIndex {
  id: string;
  name: string;
  summary?: string;
  sourcePath: string;
  raw: Record<string, unknown>;
}

export interface MemoryRecipe {
  id: string;
  system: string;
  title: string;
  status: string;
  sourcePath: string;
  requiredClaims: string[];
  raw: Record<string, unknown>;
}

export interface LoadedMemory {
  loadedConfig: LoadedConfig;
  claims: MemoryClaim[];
  graphs: MemoryGraph[];
  indexes: MemoryIndex[];
  recipes: MemoryRecipe[];
}

export function loadMemory(cwd?: string): LoadedMemory {
  const loadedConfig = loadConfig({ cwd });
  const repoRoot = loadedConfig.repo.root;
  const memoryRoot = path.join(repoRoot, loadedConfig.config.memory_root);

  return {
    loadedConfig,
    claims: loadClaims(memoryRoot, discoverFiles(memoryRoot, loadedConfig.config.claims)),
    graphs: loadGraphs(memoryRoot, discoverFiles(memoryRoot, loadedConfig.config.graphs)),
    indexes: loadIndexes(memoryRoot, discoverFiles(memoryRoot, loadedConfig.config.indexes)),
    recipes: loadRecipes(memoryRoot, discoverFiles(memoryRoot, loadedConfig.config.recipes))
  };
}

function loadClaims(memoryRoot: string, files: string[]): MemoryClaim[] {
  return files.map((filePath) => {
    const relativePath = path.relative(memoryRoot, filePath);
    const markdown = parseMarkdownFile(filePath);
    const raw = asRecord(markdown.frontmatter);

    return {
      id: readString(raw, "id"),
      type: readString(raw, "type"),
      system: readString(raw, "system"),
      status: readString(raw, "status"),
      confidence: readString(raw, "confidence"),
      severity: readString(raw, "severity"),
      title: readString(raw, "title"),
      claim: readString(raw, "claim"),
      sourcePath: relativePath,
      sourceFiles: readStringArray(raw, "source_files"),
      relatedFiles: readOptionalStringArray(raw, "related_files"),
      symbols: readOptionalStringArray(raw, "symbols"),
      routes: readOptionalStringArray(raw, "routes"),
      tags: readStringArray(raw, "tags"),
      verification: readOptionalStringArray(raw, "verification"),
      raw
    };
  });
}

function loadGraphs(memoryRoot: string, files: string[]): MemoryGraph[] {
  return files.map((filePath) => {
    const relativePath = path.relative(memoryRoot, filePath);
    const raw = asRecord(parseYaml(fs.readFileSync(filePath, "utf8")));

    return {
      id: readString(raw, "id"),
      name: readString(raw, "name"),
      sourcePath: relativePath,
      edges: readRecords(raw, "edges").map((edge) => ({
        source: readOptionalString(edge, "source"),
        target: readOptionalString(edge, "target"),
        claims: readOptionalStringArray(edge, "claims"),
        relation: readString(edge, "relation"),
        reason: readOptionalString(edge, "reason"),
        strength: readOptionalNumber(edge, "strength") ?? 50,
        bidirectional: readOptionalBoolean(edge, "bidirectional") ?? false,
        raw: edge
      })),
      raw
    };
  });
}

function loadIndexes(memoryRoot: string, files: string[]): MemoryIndex[] {
  return files.map((filePath) => {
    const relativePath = path.relative(memoryRoot, filePath);
    const raw = asRecord(parseYaml(fs.readFileSync(filePath, "utf8")));

    return {
      id: readString(raw, "id"),
      name: readString(raw, "name"),
      summary: readOptionalString(raw, "summary"),
      sourcePath: relativePath,
      raw
    };
  });
}

function loadRecipes(memoryRoot: string, files: string[]): MemoryRecipe[] {
  return files.map((filePath) => {
    const relativePath = path.relative(memoryRoot, filePath);
    const raw = asRecord(parseYaml(fs.readFileSync(filePath, "utf8")));

    return {
      id: readString(raw, "id"),
      system: readString(raw, "system"),
      title: readString(raw, "title"),
      status: readString(raw, "status"),
      sourcePath: relativePath,
      requiredClaims: readOptionalStringArray(raw, "required_claims"),
      raw
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function readString(data: Record<string, unknown>, field: string): string {
  return typeof data[field] === "string" ? data[field] : "";
}

function readOptionalString(data: Record<string, unknown>, field: string): string | undefined {
  const value = data[field];
  return typeof value === "string" ? value : undefined;
}

function readOptionalNumber(data: Record<string, unknown>, field: string): number | undefined {
  const value = data[field];
  return typeof value === "number" ? value : undefined;
}

function readOptionalBoolean(data: Record<string, unknown>, field: string): boolean | undefined {
  const value = data[field];
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(data: Record<string, unknown>, field: string): string[] {
  const value = data[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readOptionalStringArray(data: Record<string, unknown>, field: string): string[] {
  return readStringArray(data, field);
}

function readRecords(data: Record<string, unknown>, field: string): Array<Record<string, unknown>> {
  const value = data[field];
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
}
