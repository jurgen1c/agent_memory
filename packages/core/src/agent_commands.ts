export interface AgentCommandDescription {
  name: string;
  purpose: string;
  whenToUse: string;
  examples: string[];
}

export function buildAgentCommands(commandPrefix: string): AgentCommandDescription[] {
  return [
    {
      name: "sync",
      purpose: "Compile memory, validate source files, and run health checks.",
      whenToUse: "Run before agent work or after checkout, merge, pull, or rebase.",
      examples: [`${commandPrefix} sync`]
    },
    {
      name: "context",
      purpose: "Retrieve task, changed-file, or diff-specific memory for agent work.",
      whenToUse: "Run before editing code so relevant claims, recipes, and verification steps are visible.",
      examples: [
        `${commandPrefix} context --task "fix student oauth"`,
        `${commandPrefix} context --changed-files src/auth.js`,
        `${commandPrefix} context --git-diff`
      ]
    },
    {
      name: "coverage",
      purpose: "Check whether changed watched files have related memory updates or waivers.",
      whenToUse: "Run before finishing work, especially in CI or when watched files changed.",
      examples: [`${commandPrefix} coverage --git-diff`, `${commandPrefix} coverage --git-diff --base origin/main`]
    },
    {
      name: "query",
      purpose: "Search compiled claims by topic.",
      whenToUse: "Use when you need memory about a behavior, subsystem, file, symbol, or route.",
      examples: [`${commandPrefix} query "student oauth tenant"`]
    },
    {
      name: "show",
      purpose: "Show one claim and optionally graph-related claims.",
      whenToUse: "Use when you need exact claim metadata, linked files, tags, or graph context.",
      examples: [`${commandPrefix} show auth.student_oauth.uid_is_tenant_scoped --include-related`]
    },
    {
      name: "system",
      purpose: "Summarize memory for one system.",
      whenToUse: "Use before editing a subsystem to inspect critical claims, recipes, watched files, and graph activity.",
      examples: [`${commandPrefix} system auth`]
    },
    {
      name: "templates",
      purpose: "List and show claim templates.",
      whenToUse: "Use before creating claims so new memory follows the supported shape.",
      examples: [`${commandPrefix} templates list`, `${commandPrefix} templates show claim:fact`]
    },
    {
      name: "migrate-docs",
      purpose: "Plan or create proposed memory drafts from existing repository docs.",
      whenToUse: "Use when adopting agent-memory in a repo with existing documentation.",
      examples: [
        `${commandPrefix} migrate-docs --from docs/legacy --system auth`,
        `${commandPrefix} migrate-docs --from docs/legacy --system auth --automatic`
      ]
    },
    {
      name: "new claim",
      purpose: "Create one atomic claim from a built-in template.",
      whenToUse: "Use when behavior, architecture, workflow, or constraints changed.",
      examples: [`${commandPrefix} new claim --type fact --system auth --title "Student OAuth UID is tenant scoped"`]
    },
    {
      name: "validate",
      purpose: "Validate canonical memory files.",
      whenToUse: "Run before finishing changes to catch invalid claims, graphs, indexes, recipes, and waivers.",
      examples: [`${commandPrefix} validate`]
    },
    {
      name: "compile",
      purpose: "Build the repo-local SQLite cache from canonical memory.",
      whenToUse: "Run after changing canonical memory or before retrieval if the database is missing.",
      examples: [`${commandPrefix} compile`]
    },
    {
      name: "doctor",
      purpose: "Check whether the compiled database is present, fresh, and compatible.",
      whenToUse: "Run when retrieval fails or after repository state changes.",
      examples: [`${commandPrefix} doctor`]
    }
  ];
}
