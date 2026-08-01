import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { AgentMemoryError } from "../../../core/src/errors";
import { createRecipe } from "../../../core/src/recipe_templates";
import { createClaim, isClaimSeverity, isClaimType, type ClaimSeverity, type ClaimType } from "../../../core/src/templates";

export interface NewCommandContext {
  cwd?: string;
}

interface ParsedNewClaimArgs {
  interactive: boolean;
  type?: ClaimType;
  system?: string;
  title?: string;
  id?: string;
  sourceFile?: string;
  claim?: string;
  verificationStep?: string;
  severity?: ClaimSeverity;
  force?: boolean;
}

interface ParsedNewRecipeArgs {
  interactive: boolean;
  system?: string;
  title?: string;
  id?: string;
  intentTriggers: string[];
  relevantFiles: string[];
  requiredClaims: string[];
  steps: string[];
  verification: string[];
  force?: boolean;
}

export async function runNewCommand(args: string[], context: NewCommandContext = {}): Promise<string> {
  const [kind, ...rest] = args;

  if (kind === "claim") {
    return createClaimOutput(rest, context);
  }

  if (kind === "recipe") {
    return createRecipeOutput(rest, context);
  }

  throw new AgentMemoryError(`Unknown new target: ${kind ?? ""}`.trim(), {
    details: [
      "Expected: agent-memory new claim --type <type> --system <system> --title <title>",
      "Or: agent-memory new recipe --system <system> --title <title>"
    ]
  });
}

async function createClaimOutput(args: string[], context: NewCommandContext): Promise<string> {
  const parsed = await completeNewClaimArgs(parseNewClaimArgs(args));
  const result = createClaim({
    cwd: context.cwd,
    type: parsed.type,
    system: parsed.system,
    title: parsed.title,
    id: parsed.id,
    sourceFile: parsed.sourceFile,
    claim: parsed.claim,
    verificationStep: parsed.verificationStep,
    severity: parsed.severity,
    force: parsed.force
  });

  return [
    "Claim draft created.",
    "Status: needs_review",
    "Confidence: low",
    `ID: ${result.id}`,
    `Path: ${result.relativePath}`
  ].join("\n");
}

async function createRecipeOutput(args: string[], context: NewCommandContext): Promise<string> {
  const parsed = await completeNewRecipeArgs(parseNewRecipeArgs(args));
  const result = createRecipe({
    cwd: context.cwd,
    system: parsed.system,
    title: parsed.title,
    id: parsed.id,
    intentTriggers: parsed.intentTriggers,
    relevantFiles: parsed.relevantFiles,
    requiredClaims: parsed.requiredClaims,
    steps: parsed.steps,
    verification: parsed.verification,
    force: parsed.force
  });

  return [
    "Recipe draft created.",
    "Status: needs_review",
    `ID: ${result.id}`,
    `Path: ${result.relativePath}`
  ].join("\n");
}

function parseNewRecipeArgs(args: string[]): ParsedNewRecipeArgs {
  const parsed: ParsedNewRecipeArgs = {
    interactive: false,
    intentTriggers: [],
    relevantFiles: [],
    requiredClaims: [],
    steps: [],
    verification: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--interactive") {
      parsed.interactive = true;
      continue;
    }

    if (arg === "--force") {
      parsed.force = true;
      continue;
    }

    const scalar = recipeScalarOption(arg);
    if (scalar) {
      const value = arg === scalar.option ? readOptionValue(args, index, scalar.option) : arg.slice(`${scalar.option}=`.length);
      if (arg === scalar.option) index += 1;
      if (scalar.field === "system") parsed.system = value;
      else if (scalar.field === "title") parsed.title = value;
      else parsed.id = value;
      continue;
    }

    const repeated = recipeRepeatedOption(arg);
    if (repeated) {
      const value = arg === repeated.option ? readOptionValue(args, index, repeated.option) : arg.slice(`${repeated.option}=`.length);
      if (arg === repeated.option) index += 1;
      parsed[repeated.field].push(value);
      continue;
    }

    throw new AgentMemoryError(`Unknown new recipe option: ${arg}`, {
      details: ["Run `agent-memory help new` for usage."]
    });
  }

  return parsed;
}

function recipeScalarOption(arg: string): {
  option: "--system" | "--title" | "--id";
  field: "system" | "title" | "id";
} | null {
  for (const option of ["--system", "--title", "--id"] as const) {
    if (arg === option || arg.startsWith(`${option}=`)) {
      return { option, field: option.slice(2) as "system" | "title" | "id" };
    }
  }
  return null;
}

function recipeRepeatedOption(arg: string): {
  option: "--trigger" | "--source-file" | "--required-claim" | "--step" | "--verification-step";
  field: "intentTriggers" | "relevantFiles" | "requiredClaims" | "steps" | "verification";
} | null {
  const options = [
    ["--trigger", "intentTriggers"],
    ["--source-file", "relevantFiles"],
    ["--required-claim", "requiredClaims"],
    ["--step", "steps"],
    ["--verification-step", "verification"]
  ] as const;

  for (const [option, field] of options) {
    if (arg === option || arg.startsWith(`${option}=`)) return { option, field };
  }
  return null;
}

async function completeNewRecipeArgs(parsed: ParsedNewRecipeArgs): Promise<ParsedNewRecipeArgs & { system: string; title: string }> {
  if (parsed.interactive) {
    const rl = readline.createInterface({ input, output });

    try {
      parsed.system ??= await rl.question("System: ");
      parsed.title ??= await rl.question("Title: ");
      appendOptional(parsed.intentTriggers, await rl.question("Intent trigger: "));
      appendOptional(parsed.relevantFiles, await rl.question("Relevant source file: "));
      appendOptional(parsed.steps, await rl.question("First step: "));
      appendOptional(parsed.verification, await rl.question("Verification step: "));
    } finally {
      rl.close();
    }
  }

  const missing = [parsed.system ? null : "--system", parsed.title ? null : "--title"].filter(
    (value): value is string => value !== null
  );
  if (missing.length > 0) {
    throw new AgentMemoryError(`Missing required new recipe options: ${missing.join(", ")}`, {
      details: ["Use --interactive or pass --system and --title."]
    });
  }

  return parsed as ParsedNewRecipeArgs & { system: string; title: string };
}

function appendOptional(values: string[], value: string): void {
  const trimmed = value.trim();
  if (trimmed.length > 0) values.push(trimmed);
}

function parseNewClaimArgs(args: string[]): ParsedNewClaimArgs {
  const parsed: ParsedNewClaimArgs = {
    interactive: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--interactive") {
      parsed.interactive = true;
      continue;
    }

    if (arg === "--force") {
      parsed.force = true;
      continue;
    }

    if (arg === "--type") {
      parsed.type = parseClaimType(readOptionValue(args, index, "--type"));
      index += 1;
      continue;
    }

    if (arg.startsWith("--type=")) {
      parsed.type = parseClaimType(arg.slice("--type=".length));
      continue;
    }

    if (arg === "--system") {
      parsed.system = readOptionValue(args, index, "--system");
      index += 1;
      continue;
    }

    if (arg.startsWith("--system=")) {
      parsed.system = arg.slice("--system=".length);
      continue;
    }

    if (arg === "--title") {
      parsed.title = readOptionValue(args, index, "--title");
      index += 1;
      continue;
    }

    if (arg.startsWith("--title=")) {
      parsed.title = arg.slice("--title=".length);
      continue;
    }

    if (arg === "--id") {
      parsed.id = readOptionValue(args, index, "--id");
      index += 1;
      continue;
    }

    if (arg.startsWith("--id=")) {
      parsed.id = arg.slice("--id=".length);
      continue;
    }

    if (arg === "--source-file") {
      parsed.sourceFile = readOptionValue(args, index, "--source-file");
      index += 1;
      continue;
    }

    if (arg.startsWith("--source-file=")) {
      parsed.sourceFile = arg.slice("--source-file=".length);
      continue;
    }

    if (arg === "--claim") {
      parsed.claim = readOptionValue(args, index, "--claim");
      index += 1;
      continue;
    }

    if (arg.startsWith("--claim=")) {
      parsed.claim = arg.slice("--claim=".length);
      continue;
    }

    if (arg === "--verification-step") {
      parsed.verificationStep = readOptionValue(args, index, "--verification-step");
      index += 1;
      continue;
    }

    if (arg.startsWith("--verification-step=")) {
      parsed.verificationStep = arg.slice("--verification-step=".length);
      continue;
    }

    if (arg === "--severity") {
      parsed.severity = parseSeverity(readOptionValue(args, index, "--severity"));
      index += 1;
      continue;
    }

    if (arg.startsWith("--severity=")) {
      parsed.severity = parseSeverity(arg.slice("--severity=".length));
      continue;
    }

    throw new AgentMemoryError(`Unknown new claim option: ${arg}`, {
      details: ["Run `agent-memory help new` for usage."]
    });
  }

  return parsed;
}

async function completeNewClaimArgs(parsed: ParsedNewClaimArgs): Promise<{
  type: ClaimType;
  system: string;
  title: string;
  id?: string;
  sourceFile?: string;
  claim?: string;
  verificationStep?: string;
  severity?: ClaimSeverity;
  force?: boolean;
}> {
  if (parsed.interactive) {
    const rl = readline.createInterface({ input, output });

    try {
      parsed.type ??= parseClaimType(await rl.question("Claim type: "));
      parsed.system ??= await rl.question("System: ");
      parsed.title ??= await rl.question("Title: ");
      parsed.sourceFile ??= optional(await rl.question("Source file: "));
      parsed.claim ??= optional(await rl.question("Claim text: "));
      parsed.verificationStep ??= optional(await rl.question("Verification step: "));
      parsed.severity ??= parseOptionalSeverity(await rl.question("Severity: "));
    } finally {
      rl.close();
    }
  }

  assertCompleteNewClaimArgs(parsed);

  return {
    type: parsed.type,
    system: parsed.system,
    title: parsed.title,
    id: parsed.id,
    sourceFile: parsed.sourceFile,
    claim: parsed.claim,
    verificationStep: parsed.verificationStep,
    severity: parsed.severity,
    force: parsed.force
  };
}

function assertCompleteNewClaimArgs(
  parsed: ParsedNewClaimArgs
): asserts parsed is ParsedNewClaimArgs & { type: ClaimType; system: string; title: string } {
  const missing = [
    parsed.type ? null : "--type",
    parsed.system ? null : "--system",
    parsed.title ? null : "--title"
  ].filter((value): value is string => value !== null);

  if (missing.length > 0) {
    throw new AgentMemoryError(`Missing required new claim options: ${missing.join(", ")}`, {
      details: ["Use --interactive or pass --type, --system, and --title."]
    });
  }
}

function parseClaimType(value: string): ClaimType {
  if (isClaimType(value)) {
    return value;
  }

  throw new AgentMemoryError(`Unsupported claim type: ${value}`, {
    details: ["Expected one of: fact, rule, constraint, workflow, recipe, risk, decision, deprecation"]
  });
}

function parseSeverity(value: string): ClaimSeverity {
  if (isClaimSeverity(value)) {
    return value;
  }

  throw new AgentMemoryError(`Unsupported claim severity: ${value}`, {
    details: ["Expected one of: info, normal, important, critical"]
  });
}

function parseOptionalSeverity(value: string): ClaimSeverity | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? parseSeverity(trimmed) : undefined;
}

function readOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];

  if (!value) {
    throw new AgentMemoryError(`${option} requires a value.`);
  }

  return value;
}

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
