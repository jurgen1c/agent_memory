import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { AgentMemoryError } from "../../../core/src/errors";
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

export async function runNewCommand(args: string[], context: NewCommandContext = {}): Promise<string> {
  const [kind, ...rest] = args;

  if (kind !== "claim") {
    throw new AgentMemoryError(`Unknown new target: ${kind ?? ""}`.trim(), {
      details: ["Expected: agent-memory new claim --type <type> --system <system> --title <title>"]
    });
  }

  const parsed = await completeNewClaimArgs(parseNewClaimArgs(rest));
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
    "Claim created.",
    `ID: ${result.id}`,
    `Path: ${result.relativePath}`
  ].join("\n");
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
