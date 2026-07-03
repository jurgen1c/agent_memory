import { AgentMemoryError } from "../../../core/src/errors";
import {
  blockPlanStage,
  completePlanStage,
  createPlanRun,
  finishPlanRun,
  listPlanTemplates,
  nextPlanStage,
  promotePlanRun,
  prunePlanRuns,
  showPlanRun,
  showPlanTemplate,
  suggestPlans,
  type PlanRunDetail,
  type PlanTemplateDetail
} from "../../../core/src/plans";
import type { ExitCode } from "../../../core/src/types";

export interface PlansCommandContext {
  cwd?: string;
}

export interface PlansCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

export async function runPlansCommand(args: string[], context: PlansCommandContext = {}): Promise<PlansCommandResult> {
  const [command, ...rest] = args;

  if (command === "templates") {
    return runTemplates(rest, context.cwd);
  }

  if (command === "suggest") {
    const options = parseTaskArgs(rest, "plans suggest");
    const result = await suggestPlans({ cwd: context.cwd, task: options.task });
    return { exitCode: 0, stdout: options.json ? JSON.stringify(result, null, 2) : renderSuggest(result) };
  }

  if (command === "new") {
    const options = parseNewArgs(rest);
    const result = await createPlanRun({ cwd: context.cwd, task: options.task, templateId: options.templateId });
    return { exitCode: 0, stdout: options.json ? JSON.stringify(result, null, 2) : renderNew(result.run, result.path, result.warnings) };
  }

  if (command === "show") {
    const options = parseIdArgs(rest, "plans show");
    const result = showPlanRun({ cwd: context.cwd, id: options.id });
    return { exitCode: 0, stdout: options.json ? JSON.stringify(result, null, 2) : renderRun(result.run, result.warnings) };
  }

  if (command === "next") {
    const options = parseIdArgs(rest, "plans next");
    const result = nextPlanStage({ cwd: context.cwd, id: options.id });
    return { exitCode: 0, stdout: options.json ? JSON.stringify(result, null, 2) : renderNext(result) };
  }

  if (command === "complete-stage") {
    const options = parseStageEvidenceArgs(rest);
    const result = completePlanStage({
      cwd: context.cwd,
      id: options.id,
      stageId: options.stageId,
      evidence: options.evidence,
      allowEmptyEvidence: options.allowEmptyEvidence
    });
    return { exitCode: 0, stdout: options.json ? JSON.stringify(result, null, 2) : renderRun(result.run, result.warnings) };
  }

  if (command === "block-stage") {
    const options = parseStageReasonArgs(rest);
    const result = blockPlanStage({ cwd: context.cwd, id: options.id, stageId: options.stageId, reason: options.reason });
    return { exitCode: 0, stdout: options.json ? JSON.stringify(result, null, 2) : renderRun(result.run, result.warnings) };
  }

  if (command === "finish") {
    const options = parseFinishArgs(rest);
    const result = finishPlanRun({ ...options, cwd: context.cwd });
    return { exitCode: 0, stdout: options.json ? JSON.stringify(result, null, 2) : renderFinish(result) };
  }

  if (command === "prune") {
    const options = parsePruneArgs(rest, context.cwd);
    const result = prunePlanRuns(options);
    return { exitCode: 0, stdout: options.json ? JSON.stringify(result, null, 2) : renderPrune(result.paths, result.dryRun) };
  }

  if (command === "promote") {
    const options = parsePromoteArgs(rest, context.cwd);
    const result = promotePlanRun(options);
    return { exitCode: 0, stdout: options.json ? JSON.stringify(result, null, 2) : renderPromote(result) };
  }

  throw new AgentMemoryError("plans requires a subcommand.", {
    details: ["Expected one of: templates, suggest, new, show, next, complete-stage, block-stage, finish, prune, promote"]
  });
}

async function runTemplates(args: string[], cwd?: string): Promise<PlansCommandResult> {
  const [command, ...rest] = args;

  if (command === "list") {
    const json = rest.includes("--json");
    const result = await listPlanTemplates({ cwd });
    return { exitCode: 0, stdout: json ? JSON.stringify(result, null, 2) : renderTemplateList(result.templates) };
  }

  if (command === "show") {
    const options = parseIdArgs(rest, "plans templates show");
    const result = await showPlanTemplate({ cwd, id: options.id });
    return { exitCode: 0, stdout: options.json ? JSON.stringify(result, null, 2) : renderTemplate(result.template) };
  }

  throw new AgentMemoryError("plans templates requires list or show.");
}

function renderTemplateList(templates: PlanTemplateDetail[]): string {
  return ["# Plan Templates", "", `Count: ${templates.length}`, ...templates.map((template) => `- ${template.id}: ${template.title} (${template.status})`)].join("\n");
}

function renderTemplate(template: PlanTemplateDetail): string {
  const lines = [`# ${template.title}`, "", `ID: ${template.id}`, `System: ${template.system}`, `Status: ${template.status}`, `Source: ${template.sourcePath}`];

  if (template.intentTriggers.length > 0) {
    lines.push("", "## Intent Triggers", "", ...template.intentTriggers.map((trigger) => `- ${trigger}`));
  }

  lines.push("", "## Stages");
  for (const stage of template.stages) {
    lines.push("", `### ${stage.id}`, "", stage.goal);
  }
  return lines.join("\n");
}

function renderSuggest(result: Awaited<ReturnType<typeof suggestPlans>>): string {
  const lines = ["# Plan Suggestions", "", `Task: ${result.task}`, `Matches: ${result.matches.length}`];
  for (const match of result.matches) {
    lines.push("", `## ${match.template.id}`, "", `${match.template.title} (${match.template.status})`, `Score: ${match.score}`);
    lines.push("", "Reasons:", ...match.reasons.map((reason) => `- ${reason.code}: ${reason.detail}`));
  }
  if (result.adHocPlan) {
    lines.push("", "## Ad Hoc Plan", "", result.adHocPlan.warning);
  }
  return lines.join("\n");
}

function renderNew(run: PlanRunDetail, filePath: string, warnings: string[]): string {
  return [
    "Plan run created.",
    "",
    `ID: ${run.id}`,
    `Path: ${filePath}`,
    `Current stage: ${run.currentStage}`,
    `Context: bin/memory context --plan ${run.id} --stage ${run.currentStage}`,
    ...warnings.map((warning) => `Warning: ${warning}`)
  ].join("\n");
}

function renderRun(run: PlanRunDetail, warnings: string[]): string {
  const lines = [`# Plan Run ${run.id}`, "", `Task: ${run.task}`, `Status: ${run.status}`, `Current stage: ${run.currentStage}`];
  if (warnings.length > 0) {
    lines.push("", "## Warnings", "", ...warnings.map((warning) => `- ${warning}`));
  }
  lines.push("", "## Stages");
  for (const stage of run.stages) {
    lines.push("", `- ${stage.id}: ${stage.status}`);
  }
  return lines.join("\n");
}

function renderNext(result: Awaited<ReturnType<typeof nextPlanStage>>): string {
  return [`Next stage: ${result.stage.id}`, `Status: ${result.stage.status}`, `Context: ${result.contextCommand}`, ...result.warnings.map((warning) => `Warning: ${warning}`)].join("\n");
}

function renderFinish(result: Awaited<ReturnType<typeof finishPlanRun>>): string {
  return [`Plan run ${result.status}.`, `Path: ${result.path}`, ...result.prompts.map((prompt) => `Unresolved prompt: ${prompt}`), `Durable artifacts: ${result.durableArtifacts.join(", ")}`].join("\n");
}

function renderPrune(paths: string[], dryRun: boolean): string {
  return [`Plan runs ${dryRun ? "selected" : "pruned"}: ${paths.length}`, ...paths.map((filePath) => `- ${filePath}`)].join("\n");
}

function renderPromote(result: Awaited<ReturnType<typeof promotePlanRun>>): string {
  return [`Plan template written.`, `ID: ${result.templateId}`, `Path: ${result.path}`, ...result.warnings.map((warning) => `Warning: ${warning}`)].join("\n");
}

function parseTaskArgs(args: string[], command: string): { task: string; json: boolean } {
  let task = "";
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--task") {
      task = readValue(args, index, "--task");
      index += 1;
    } else if (arg.startsWith("--task=")) {
      task = arg.slice("--task=".length);
    } else {
      throw new AgentMemoryError(`Unknown ${command} option: ${arg}`);
    }
  }
  if (!task.trim()) {
    throw new AgentMemoryError(`${command} requires --task.`);
  }
  return { task, json };
}

function parseNewArgs(args: string[]): { task: string; templateId?: string; json: boolean } {
  const parsed = parseTaskArgs(args.filter((arg, index) => arg !== "--template" && args[index - 1] !== "--template" && !arg.startsWith("--template=")), "plans new");
  const templateIndex = args.indexOf("--template");
  const templateId = templateIndex >= 0 ? readValue(args, templateIndex, "--template") : args.find((arg) => arg.startsWith("--template="))?.slice("--template=".length);
  return { ...parsed, templateId };
}

function parseIdArgs(args: string[], command: string): { id: string; json: boolean } {
  const [id, ...rest] = args;
  if (!id || id.startsWith("--")) {
    throw new AgentMemoryError(`${command} requires an ID.`);
  }
  return { id, json: rest.includes("--json") };
}

function parseStageEvidenceArgs(args: string[]): { id: string; stageId: string; evidence: string; allowEmptyEvidence: boolean; json: boolean } {
  const [id, ...rest] = args;
  let stageId = "";
  let evidence = "";
  let allowEmptyEvidence = false;
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") json = true;
    else if (arg === "--allow-empty-evidence") allowEmptyEvidence = true;
    else if (arg === "--stage") {
      stageId = readValue(rest, index, "--stage");
      index += 1;
    } else if (arg === "--evidence") {
      evidence = readValue(rest, index, "--evidence");
      index += 1;
    } else throw new AgentMemoryError(`Unknown complete-stage option: ${arg}`);
  }
  if (!id || !stageId) throw new AgentMemoryError("complete-stage requires a plan ID and --stage.");
  return { id, stageId, evidence, allowEmptyEvidence, json };
}

function parseStageReasonArgs(args: string[]): { id: string; stageId: string; reason: string; json: boolean } {
  const [id, ...rest] = args;
  let stageId = "";
  let reason = "";
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") json = true;
    else if (arg === "--stage") {
      stageId = readValue(rest, index, "--stage");
      index += 1;
    } else if (arg === "--reason") {
      reason = readValue(rest, index, "--reason");
      index += 1;
    } else throw new AgentMemoryError(`Unknown block-stage option: ${arg}`);
  }
  if (!id || !stageId) throw new AgentMemoryError("block-stage requires a plan ID and --stage.");
  return { id, stageId, reason, json };
}

function parseFinishArgs(args: string[]): Parameters<typeof finishPlanRun>[0] & { json: boolean } {
  const [id, ...rest] = args;
  if (!id || id.startsWith("--")) {
    throw new AgentMemoryError("plans finish requires a plan ID.");
  }
  const options: Parameters<typeof finishPlanRun>[0] & { json: boolean } = { id, json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--confirm-unresolved") options.confirmUnresolved = true;
    else if (arg === "--archive") options.archive = true;
    else if (arg === "--abandon-blocked") options.abandonBlocked = true;
    else if (arg === "--reason") {
      options.reason = readValue(rest, index, "--reason");
      index += 1;
    } else throw new AgentMemoryError(`Unknown finish option: ${arg}`);
  }
  return options;
}

function parsePruneArgs(args: string[], cwd?: string): Parameters<typeof prunePlanRuns>[0] & { json: boolean } {
  const options: Parameters<typeof prunePlanRuns>[0] & { json: boolean } = { cwd, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--completed") options.completed = true;
    else if (arg === "--abandoned") options.abandoned = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--include-blocked") options.includeBlocked = true;
    else if (arg === "--older-than") {
      options.olderThanDays = parseAgeDays(readValue(args, index, "--older-than"));
      index += 1;
    } else throw new AgentMemoryError(`Unknown prune option: ${arg}`);
  }
  return options;
}

function parsePromoteArgs(args: string[], cwd?: string): Parameters<typeof promotePlanRun>[0] & { json: boolean } {
  const [id, ...rest] = args;
  const options: Parameters<typeof promotePlanRun>[0] & { json: boolean } = { cwd, id, json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--to-template") continue;
    else if (arg === "--finish-after-promote") options.finishAfterPromote = true;
    else if (arg === "--system") {
      options.system = readValue(rest, index, "--system");
      index += 1;
    } else if (arg === "--title") {
      options.title = readValue(rest, index, "--title");
      index += 1;
    } else throw new AgentMemoryError(`Unknown promote option: ${arg}`);
  }
  return options;
}

function parseAgeDays(value: string): number {
  const match = value.match(/^(\d+)d$/);
  if (!match) throw new AgentMemoryError(`Expected age like 7d, got: ${value}`);
  return Number(match[1]);
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined) throw new AgentMemoryError(`${option} requires a value.`);
  return value;
}
