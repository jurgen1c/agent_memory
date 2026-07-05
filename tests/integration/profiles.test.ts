import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch, runCli } from "../../packages/cli/src/router";

const repoRoot = path.resolve(".");
const mockApp = path.join(repoRoot, "examples/mock-app");

describe("profiles command", () => {
  test("lists and shows profile traits", async () => {
    const cwd = await compiledMockAppWithProfiles();

    const list = await dispatch(["profiles", "list"], { cwd });
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("# Profile Traits");
    expect(list.stdout).toContain("profile_trait.review.findings_first");

    const show = await dispatch(["profiles", "show", "profile_trait.review.findings_first"], { cwd });
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain("# Findings first");
    expect(show.stdout).toContain("## Guidance");
    expect(show.stdout).toContain("Lead with concrete findings");
  });

  test("matches by task intent, file glob, recipe, and alias", async () => {
    const cwd = await compiledMockAppWithProfiles();

    const intent = await dispatch(["profiles", "match", "--task", "review auth changes", "--json"], { cwd });
    const intentJson = JSON.parse(intent.stdout);
    expect(intent.exitCode).toBe(0);
    expect(intentJson.traits[0].trait.id).toBe("profile_trait.review.findings_first");
    expect(intentJson.traits[0].reasons.some((reason: { code: string; detail: string }) => reason.code === "task_intent" && reason.detail === "review")).toBe(true);
    expect(intentJson.droppedTraits).toContainEqual({
      id: "profile_trait.review.tutorial_style",
      reason: "conflicts_with profile_trait.review.findings_first"
    });

    const file = await dispatch(["profiles", "match", "--changed-files", "src/auth.js", "--json"], { cwd });
    const fileJson = JSON.parse(file.stdout);
    expect(fileJson.traits.some((match: { trait: { id: string }; reasons: Array<{ code: string }> }) => match.trait.id === "profile_trait.review.findings_first" && match.reasons.some((reason) => reason.code === "file_glob_match"))).toBe(true);

    const recipe = await dispatch(["profiles", "match", "--recipe", "recipe.auth.modify_student_oauth", "--json"], { cwd });
    const recipeJson = JSON.parse(recipe.stdout);
    expect(recipeJson.traits[0].trait.id).toBe("profile_trait.review.security_sensitive");
    expect(recipeJson.traits[0].reasons).toContainEqual({
      code: "recipe_match",
      detail: "recipe.auth.modify_student_oauth"
    });

    const alias = await dispatch(["profiles", "match", "--profile", "architect", "--json"], { cwd });
    const aliasJson = JSON.parse(alias.stdout);
    expect(aliasJson.traits[0].trait.id).toBe("profile_trait.architect.tradeoffs");
    expect(aliasJson.diagnostics.intents).toContainEqual({
      intent: "architect",
      reason: "profile alias"
    });
  });

  test("matches across equivalent applies_when array fields", async () => {
    const cwd = await compiledMockAppWithProfiles();
    writeProfile(cwd, "review/changed_files_fallback.yaml", {
      id: "profile_trait.review.changed_files_fallback",
      title: "Changed files fallback",
      category: "risk_lens",
      priority: "critical",
      appliesWhen: `file_globs: []
  changed_files:
    - src/tenant.js`,
      snippet: "Apply when tenant files change, even if a preferred alias field is present but empty."
    });
    const compile = await dispatch(["compile"], { cwd });
    expect(compile.exitCode).toBe(0);

    const result = await dispatch(["profiles", "match", "--changed-files", "src/tenant.js", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.traits.some((match: { trait: { id: string }; reasons: Array<{ code: string }> }) => match.trait.id === "profile_trait.review.changed_files_fallback" && match.reasons.some((reason) => reason.code === "file_glob_match"))).toBe(true);
  });

  test("supports explicit traits and reports missing explicit traits", async () => {
    const cwd = await compiledMockAppWithProfiles();
    const explicit = await dispatch(["profiles", "match", "--profile-trait", "profile_trait.implementer.keep_scope_tight", "--json"], { cwd });
    const explicitJson = JSON.parse(explicit.stdout);
    expect(explicit.exitCode).toBe(0);
    expect(explicitJson.traits[0].trait.id).toBe("profile_trait.implementer.keep_scope_tight");
    expect(explicitJson.traits[0].reasons).toContainEqual({
      code: "explicit_trait",
      detail: "profile_trait.implementer.keep_scope_tight"
    });

    let stderr = "";
    const missing = await runCli(
      ["profiles", "match", "--profile-trait", "profile_trait.review.missing"],
      {
        stdout: { write: () => true },
        stderr: {
          write: (chunk: string) => {
            stderr += chunk;
            return true;
          }
        }
      },
      { cwd }
    );
    expect(missing).toBe(7);
    expect(stderr).toContain("Profile trait not found: profile_trait.review.missing");
  });

  test("surfaces broad trait diagnostics", async () => {
    const cwd = await compiledMockAppWithProfiles();
    const result = await dispatch(["profiles", "match", "--profile-trait", "profile_trait.implementer.keep_scope_tight", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.diagnostics.warnings).toContain("profile_trait.implementer.keep_scope_tight is broad; keep profile traits small and specific.");

    const implicit = await dispatch(["profiles", "match", "--changed-files", "src/unrelated.js", "--json"], { cwd });
    const implicitJson = JSON.parse(implicit.stdout);
    expect(implicit.exitCode).toBe(0);
    expect(implicitJson.traits.map((match: { trait: { id: string } }) => match.trait.id)).not.toContain("profile_trait.implementer.keep_scope_tight");
  });

  test("context includes selected and dropped profile traits with caps", async () => {
    const cwd = await compiledMockAppWithProfiles((config) => `${config}\ncontext:\n  default_budget: medium\n  default_depth: 1\n  include_inferred_edges_by_default: false\n  profile_trait_limit: 1\n`);
    const result = await dispatch(["context", "--task", "review auth changes", "--recipe", "recipe.auth.modify_student_oauth", "--profile", "review", "--json"], {
      cwd
    });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.profileTraits).toHaveLength(1);
    expect(parsed.profileTraits[0].id).toBe("profile_trait.review.findings_first");
    expect(parsed.profileTraits[0].snippet).toContain("Lead with concrete findings");
    expect(parsed.droppedProfileTraits.some((trait: { id: string }) => trait.id === "profile_trait.review.security_sensitive")).toBe(true);
    expect(parsed.profileDiagnostics.intents).toContainEqual({
      intent: "review",
      reason: "profile alias"
    });

    const text = await dispatch(["context", "--task", "review auth changes", "--profile", "review"], { cwd });
    expect(text.stdout).toContain("## Selected Profile Traits");
    expect(text.stdout).toContain("profile_trait.review.findings_first");
    expect(text.stdout).toContain("## Dropped Profile Traits");

    const smallBudgetCwd = await compiledMockAppWithProfiles();
    const smallBudget = await dispatch(["context", "--task", "review auth changes", "--recipe", "recipe.auth.modify_student_oauth", "--profile", "review", "--budget", "small", "--json"], {
      cwd: smallBudgetCwd
    });
    const smallBudgetJson = JSON.parse(smallBudget.stdout);
    expect(smallBudget.exitCode).toBe(0);
    expect(smallBudgetJson.profileTraits.length).toBeLessThanOrEqual(2);
  });

  test("context includes plan-stage profile traits explicitly", async () => {
    const cwd = await compiledMockAppWithProfiles();
    writePlan(cwd);
    const compile = await dispatch(["compile"], { cwd });
    expect(compile.exitCode).toBe(0);

    const created = await dispatch(["plans", "new", "--template", "plan_template.auth.review_oauth", "--task", "review oauth change", "--json"], { cwd });
    const run = JSON.parse(created.stdout).run;
    const context = await dispatch(["context", "--plan", run.id, "--stage", "review", "--json"], { cwd });
    const parsed = JSON.parse(context.stdout);

    expect(context.exitCode).toBe(0);
    expect(parsed.profileTraits.map((trait: { id: string }) => trait.id)).toContain("profile_trait.review.findings_first");
    expect(parsed.profileTraits[0].reasons.some((reason: { code: string }) => reason.code === "explicit_trait")).toBe(true);
  });
});

async function compiledMockAppWithProfiles(updateConfig?: (config: string) => string): Promise<string> {
  const cwd = copyFixture(mockApp);
  writeProfiles(cwd);
  if (updateConfig) {
    const configPath = path.join(cwd, "agent-memory.config.yaml");
    fs.writeFileSync(configPath, updateConfig(fs.readFileSync(configPath, "utf8")));
  }
  const compile = await dispatch(["compile"], { cwd });
  expect(compile.exitCode).toBe(0);
  return cwd;
}

function copyFixture(source: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-profiles-"));
  fs.cpSync(source, target, { recursive: true });
  return target;
}

function writeProfiles(cwd: string): void {
  writeProfile(cwd, "review/findings_first.yaml", {
    id: "profile_trait.review.findings_first",
    title: "Findings first",
    category: "output_contract",
    priority: "high",
    appliesWhen: `aliases:
    - review
  intents:
    - review
  file_globs:
    - src/auth.js`,
    conflictsWith: ["profile_trait.review.tutorial_style"],
    snippet: "Lead with concrete findings ordered by severity. Include file and line references for each finding. Keep summary secondary."
  });
  writeProfile(cwd, "review/tutorial_style.yaml", {
    id: "profile_trait.review.tutorial_style",
    title: "Tutorial style",
    category: "output_contract",
    priority: "normal",
    appliesWhen: `intents:
    - review`,
    conflictsWith: ["profile_trait.review.findings_first"],
    snippet: "Explain the code in tutorial form before listing review findings."
  });
  writeProfile(cwd, "review/security_sensitive.yaml", {
    id: "profile_trait.review.security_sensitive",
    title: "Security sensitive review",
    category: "risk_lens",
    priority: "high",
    appliesWhen: `systems:
    - auth
  recipes:
    - recipe.auth.modify_student_oauth
  risk_signals:
    - oauth`,
    snippet: "Treat OAuth changes as security-sensitive and verify tenant boundaries."
  });
  writeProfile(cwd, "architect/tradeoffs.yaml", {
    id: "profile_trait.architect.tradeoffs",
    title: "Tradeoff analysis",
    category: "output_contract",
    priority: "high",
    appliesWhen: `aliases:
    - architect
  intents:
    - architect`,
    snippet: "Frame architecture guidance around concrete tradeoffs, constraints, and migration costs."
  });
  writeProfile(cwd, "implementer/keep_scope_tight.yaml", {
    id: "profile_trait.implementer.keep_scope_tight",
    title: "Keep scope tight",
    category: "scope_control",
    priority: "low",
    appliesWhen: "always: true",
    snippet: "Keep implementation changes scoped to the requested behavior and avoid unrelated refactors."
  });
}

function writeProfile(
  cwd: string,
  relativePath: string,
  options: {
    id: string;
    title: string;
    category: string;
    priority: string;
    appliesWhen: string;
    snippet: string;
    conflictsWith?: string[];
  }
): void {
  const profilePath = path.join(cwd, "docs/agent-memory/profiles", relativePath);
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  const conflicts = options.conflictsWith?.length ? `conflicts_with:\n${options.conflictsWith.map((id) => `  - ${id}`).join("\n")}\n` : "";
  fs.writeFileSync(
    profilePath,
    `id: ${options.id}
title: ${options.title}
status: current
category: ${options.category}
priority: ${options.priority}
applies_when:
  ${options.appliesWhen}
${conflicts}snippet: ${JSON.stringify(options.snippet)}
`
  );
}

function writePlan(cwd: string): void {
  const planPath = path.join(cwd, "docs/agent-memory/plans/auth/review_oauth.yaml");
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(
    planPath,
    `id: plan_template.auth.review_oauth
title: Review OAuth change
system: auth
status: current
stages:
  - id: review
    title: Review OAuth behavior
    goal: Review OAuth behavior and tenant boundaries.
    claim_refs:
      - auth.student_oauth.uid_is_tenant_scoped
    recipe_refs:
      - recipe.auth.modify_student_oauth
    profile_traits:
      - profile_trait.review.findings_first
    source_files:
      - src/auth.js
    verification:
      - bun test
`
  );
}
