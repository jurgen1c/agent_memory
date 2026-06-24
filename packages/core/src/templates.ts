import fs from "node:fs";
import path from "node:path";
import { AgentMemoryError, NotFoundError } from "./errors";
import { loadConfig } from "./config";

export const CLAIM_TYPES = [
  "fact",
  "rule",
  "constraint",
  "workflow",
  "recipe",
  "risk",
  "decision",
  "deprecation"
] as const;

export const CLAIM_SEVERITIES = ["info", "normal", "important", "critical"] as const;

export type ClaimType = (typeof CLAIM_TYPES)[number];
export type TemplateName = `claim:${ClaimType}`;
export type ClaimSeverity = "info" | "normal" | "important" | "critical";

export interface TemplateSummary {
  name: TemplateName;
  type: ClaimType;
  description: string;
}

export interface CopyTemplateOptions {
  to: string;
  cwd?: string;
  force?: boolean;
}

export interface CopyTemplateResult {
  path: string;
  status: "created" | "overwritten";
}

export interface NewClaimOptions {
  cwd?: string;
  type: ClaimType;
  system: string;
  title: string;
  id?: string;
  sourceFile?: string;
  claim?: string;
  verificationStep?: string;
  severity?: ClaimSeverity;
  force?: boolean;
}

export interface NewClaimResult {
  id: string;
  path: string;
  relativePath: string;
  status: "created";
}

const TEMPLATE_DESCRIPTIONS: Record<ClaimType, string> = {
  fact: "A specific verifiable repository fact.",
  rule: "A critical rule agents must follow.",
  constraint: "A durable implementation or process constraint.",
  workflow: "A repeatable workflow claim.",
  recipe: "A claim documenting a repeatable recipe.",
  risk: "A durable risk and mitigation note.",
  decision: "A documented architecture or product decision.",
  deprecation: "A claim documenting deprecated behavior and replacement."
};

const CLAIM_TEMPLATES: Record<ClaimType, string> = {
  fact: `---
id: {{id}}
type: fact
system: {{system}}
status: current
confidence: medium
severity: {{severity}}

title: {{title}}

claim: >
  {{claim}}

source_files:
  - {{source_file}}

related_files: []
symbols: []
routes: []
tags:
  - {{system}}

verification:
  - {{verification_step}}

last_verified_commit: null
---

# {{title}}

## Claim

{{claim}}

## Why It Matters

{{why_it_matters}}

## Evidence

- \`{{source_file}}\`

## Verification

- {{verification_step}}
`,

  constraint: `---
id: {{id}}
type: constraint
system: {{system}}
status: current
confidence: medium
severity: {{severity}}

title: {{title}}

claim: >
  {{claim}}

source_files:
  - {{source_file}}

tags:
  - {{system}}
  - constraint

verification:
  - {{verification_step}}

last_verified_commit: null
---

# {{title}}

## Claim

{{claim}}

## Constraint

{{constraint_detail}}

## Why It Matters

{{why_it_matters}}

## Verification

- {{verification_step}}
`,

  rule: `---
id: {{id}}
type: rule
system: {{system}}
status: current
confidence: medium
severity: {{severity}}

title: {{title}}

claim: >
  {{rule}}

source_files:
  - {{source_file}}

tags:
  - {{system}}
  - rule

verification:
  - {{verification_step}}

last_verified_commit: null
---

# {{title}}

## Rule

{{rule}}

## Severity

Critical unless changed in frontmatter.

## Why It Matters

{{why_it_matters}}

## Verification

- {{verification_step}}
`,

  workflow: `---
id: {{id}}
type: workflow
system: {{system}}
status: current
confidence: medium
severity: {{severity}}

title: {{title}}

claim: >
  {{workflow_summary}}

source_files:
  - {{source_file}}

tags:
  - {{system}}
  - workflow

verification:
  - {{verification_step}}

last_verified_commit: null
---

# {{title}}

## Workflow

{{workflow_summary}}

## Steps

1. {{step_one}}
2. {{step_two}}
3. {{step_three}}

## Why It Matters

{{why_it_matters}}

## Verification

- {{verification_step}}
`,

  recipe: `---
id: {{id}}
type: recipe
system: {{system}}
status: current
confidence: medium
severity: {{severity}}

title: {{title}}

claim: >
  {{recipe_summary}}

source_files:
  - {{source_file}}

tags:
  - {{system}}
  - recipe

verification:
  - {{verification_step}}

last_verified_commit: null
---

# {{title}}

## Recipe

{{recipe_summary}}

## Steps

1. {{step_one}}
2. {{step_two}}
3. {{step_three}}

## Verification

- {{verification_step}}
`,

  risk: `---
id: {{id}}
type: risk
system: {{system}}
status: current
confidence: medium
severity: {{severity}}

title: {{title}}

claim: >
  {{risk_summary}}

source_files:
  - {{source_file}}

tags:
  - {{system}}
  - risk

verification:
  - {{verification_step}}

last_verified_commit: null
---

# {{title}}

## Risk

{{risk_summary}}

## Trigger

{{trigger}}

## Mitigation

{{mitigation}}

## Verification

- {{verification_step}}
`,

  decision: `---
id: {{id}}
type: decision
system: {{system}}
status: current
confidence: medium
severity: {{severity}}

title: {{title}}

claim: >
  {{decision_summary}}

source_files:
  - {{source_file}}

tags:
  - {{system}}
  - decision

verification:
  - {{verification_step}}

last_verified_commit: null
---

# {{title}}

## Decision

{{decision_summary}}

## Rationale

{{rationale}}

## Alternatives Considered

- {{alternative}}

## Verification

- {{verification_step}}
`,

  deprecation: `---
id: {{id}}
type: deprecation
system: {{system}}
status: deprecated
confidence: medium
severity: {{severity}}

title: {{title}}

claim: >
  {{deprecated_behavior}}

source_files:
  - {{source_file}}

deprecated_by: {{replacement_claim_id}}

tags:
  - {{system}}
  - deprecation

verification:
  - Confirm callers use the replacement behavior.

last_verified_commit: null
---

# {{title}}

## Deprecated Behavior

{{deprecated_behavior}}

## Replacement

Use \`{{replacement_claim_id}}\`.

## Why It Was Deprecated

{{deprecation_reason}}
`
};

export function listTemplates(): TemplateSummary[] {
  return CLAIM_TYPES.map((type) => ({
    name: `claim:${type}`,
    type,
    description: TEMPLATE_DESCRIPTIONS[type]
  }));
}

export function getTemplate(name: string): string {
  const type = parseTemplateName(name);
  return CLAIM_TEMPLATES[type];
}

export function copyTemplate(name: string, options: CopyTemplateOptions): CopyTemplateResult {
  const targetPath = path.resolve(options.cwd ?? process.cwd(), options.to);

  if (fs.existsSync(targetPath) && !options.force) {
    throw new AgentMemoryError(`Refusing to overwrite existing file: ${targetPath}`, {
      details: ["Pass --force to overwrite the destination."]
    });
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const existedBefore = fs.existsSync(targetPath);
  fs.writeFileSync(targetPath, getTemplate(name));

  return {
    path: targetPath,
    status: existedBefore ? "overwritten" : "created"
  };
}

export function createClaim(options: NewClaimOptions): NewClaimResult {
  const loaded = loadConfig({ cwd: options.cwd });
  const memoryRoot = path.resolve(loaded.repo.root, loaded.config.memory_root);
  const normalizedSystem = normalizeSystem(options.system);
  const sourceFile = options.sourceFile ?? "TODO_SOURCE_FILE";
  const verificationStep = options.verificationStep ?? "TODO: Add a concrete verification step.";
  const claimText = options.claim ?? `TODO: Document ${options.title}.`;
  const explicitId = options.id;
  const generatedBaseId = explicitId ?? `${normalizedSystem}.${slugify(options.title, "_")}`;
  const existingIds = collectExistingClaimIds(memoryRoot);
  const claimId = explicitId ? assertExplicitIdAvailable(explicitId, existingIds) : nextAvailableId(generatedBaseId, existingIds);
  const baseSlug = explicitId ? slugFromClaimId(claimId, normalizedSystem) : slugify(options.title, "-");
  const relativePath = nextAvailableClaimPath(loaded.repo.root, loaded.config.memory_root, normalizedSystem, baseSlug, options.force);
  const absolutePath = path.join(loaded.repo.root, relativePath);

  if (fs.existsSync(absolutePath) && !options.force) {
    throw new AgentMemoryError(`Refusing to overwrite existing claim file: ${absolutePath}`);
  }

  const content = renderTemplate(`claim:${options.type}`, {
    id: claimId,
    system: normalizedSystem,
    title: options.title,
    severity: options.severity ?? defaultSeverity(options.type),
    claim: claimText,
    rule: claimText,
    workflow_summary: claimText,
    recipe_summary: claimText,
    risk_summary: claimText,
    decision_summary: claimText,
    deprecated_behavior: claimText,
    source_file: sourceFile,
    verification_step: verificationStep,
    why_it_matters: "TODO: Explain why this memory matters.",
    constraint_detail: claimText,
    step_one: "TODO: Add the first step.",
    step_two: "TODO: Add the second step.",
    step_three: "TODO: Add the third step.",
    trigger: "TODO: Describe when this risk applies.",
    mitigation: "TODO: Describe the mitigation.",
    rationale: "TODO: Explain the rationale.",
    alternative: "TODO: List an alternative considered.",
    replacement_claim_id: "TODO_REPLACEMENT_CLAIM_ID",
    deprecation_reason: "TODO: Explain why this behavior was deprecated."
  });

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);

  return {
    id: claimId,
    path: absolutePath,
    relativePath,
    status: "created"
  };
}

export function renderTemplate(name: string, values: Record<string, string>): string {
  return getTemplate(name).replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => values[key] ?? `TODO_${key.toUpperCase()}`);
}

export function parseTemplateName(name: string): ClaimType {
  if (!name.startsWith("claim:")) {
    throw new NotFoundError(`Unknown template: ${name}`, {
      details: ["Template names use the form claim:<type>."]
    });
  }

  const type = name.slice("claim:".length);

  if (isClaimType(type)) {
    return type;
  }

  throw new NotFoundError(`Unknown claim template type: ${type}`, {
    details: [`Known claim types: ${CLAIM_TYPES.join(", ")}`]
  });
}

export function isClaimType(value: string): value is ClaimType {
  return (CLAIM_TYPES as readonly string[]).includes(value);
}

export function isClaimSeverity(value: string): value is ClaimSeverity {
  return (CLAIM_SEVERITIES as readonly string[]).includes(value);
}

export function slugify(value: string, separator = "-"): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`${escapeRegExp(separator)}+`, "g"), separator)
    .replace(new RegExp(`^${escapeRegExp(separator)}|${escapeRegExp(separator)}$`, "g"), "");

  return slug.length > 0 ? slug : "untitled";
}

function normalizeSystem(system: string): string {
  return slugify(system, "_");
}

function assertExplicitIdAvailable(id: string, existingIds: Set<string>): string {
  if (existingIds.has(id)) {
    throw new AgentMemoryError(`Claim ID already exists: ${id}`);
  }

  return id;
}

function nextAvailableId(baseId: string, existingIds: Set<string>): string {
  if (!existingIds.has(baseId)) {
    return baseId;
  }

  let counter = 2;

  while (existingIds.has(`${baseId}_${counter}`)) {
    counter += 1;
  }

  return `${baseId}_${counter}`;
}

function nextAvailableClaimPath(repoRoot: string, memoryRoot: string, system: string, baseSlug: string, force?: boolean): string {
  const basePath = path.join(memoryRoot, "claims", system, `${baseSlug}.md`);

  if (force || !fs.existsSync(path.join(repoRoot, basePath))) {
    return basePath;
  }

  let counter = 2;

  while (fs.existsSync(path.join(repoRoot, memoryRoot, "claims", system, `${baseSlug}-${counter}.md`))) {
    counter += 1;
  }

  return path.join(memoryRoot, "claims", system, `${baseSlug}-${counter}.md`);
}

function slugFromClaimId(id: string, system: string): string {
  const withoutSystem = id.startsWith(`${system}.`) ? id.slice(system.length + 1) : id;
  return slugify(withoutSystem.replace(/\./g, "-"), "-");
}

function collectExistingClaimIds(memoryRoot: string): Set<string> {
  const claimsRoot = path.join(memoryRoot, "claims");
  const ids = new Set<string>();

  if (!fs.existsSync(claimsRoot)) {
    return ids;
  }

  for (const filePath of walkMarkdownFiles(claimsRoot)) {
    const raw = fs.readFileSync(filePath, "utf8");
    const match = raw.match(/^id:\s*([^\s]+)/m);

    if (match) {
      ids.add(match[1]);
    }
  }

  return ids;
}

function walkMarkdownFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkMarkdownFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }

  return files;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultSeverity(type: ClaimType): ClaimSeverity {
  if (type === "rule") {
    return "critical";
  }

  if (type === "constraint" || type === "risk" || type === "deprecation") {
    return "important";
  }

  return "normal";
}
