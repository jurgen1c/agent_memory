import { copyTemplate, getTemplate, listTemplates } from "../../../core/src/templates";
import { AgentMemoryError } from "../../../core/src/errors";

export function runTemplatesCommand(args: string[], cwd?: string): string {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === "list") {
    return renderTemplateList();
  }

  if (subcommand === "show") {
    const [name, ...extra] = rest;

    if (!name) {
      throw new AgentMemoryError("templates show requires a template name.");
    }

    if (extra.length > 0) {
      throw new AgentMemoryError(`Unexpected templates show arguments: ${extra.join(" ")}`);
    }

    return getTemplate(name);
  }

  if (subcommand === "copy") {
    return runCopyTemplate(rest, cwd);
  }

  throw new AgentMemoryError(`Unknown templates subcommand: ${subcommand}`, {
    details: ["Expected one of: list, show, copy"]
  });
}

function renderTemplateList(): string {
  return [
    "Available templates:",
    ...listTemplates().map((template) => `  ${template.name.padEnd(18)} ${template.description}`)
  ].join("\n");
}

function runCopyTemplate(args: string[], cwd?: string): string {
  const [name, ...rest] = args;
  let to: string | undefined;
  let force = false;

  if (!name) {
    throw new AgentMemoryError("templates copy requires a template name.");
  }

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--force") {
      force = true;
      continue;
    }

    if (arg === "--to") {
      to = rest[index + 1];

      if (!to) {
        throw new AgentMemoryError("--to requires a destination path.");
      }

      index += 1;
      continue;
    }

    if (arg.startsWith("--to=")) {
      to = arg.slice("--to=".length);
      continue;
    }

    throw new AgentMemoryError(`Unknown templates copy option: ${arg}`);
  }

  if (!to) {
    throw new AgentMemoryError("templates copy requires --to <path>.");
  }

  const result = copyTemplate(name, { to, cwd, force });
  return `Template ${name} ${result.status}: ${result.path}`;
}
