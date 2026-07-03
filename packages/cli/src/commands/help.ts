import { NotFoundError } from "../../../core/src/errors";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../../core/src/version";

interface HelpTopic {
  name: string;
  purpose: string;
  usage: string[];
  examples: string[];
  agentNotes: string[];
  phase: string;
}

const TOPICS: HelpTopic[] = [
  {
    name: "help",
    purpose: "Show command purpose, usage, examples, and agent notes.",
    usage: ["agent-memory help", "agent-memory help <command>"],
    examples: ["agent-memory help", "agent-memory help init"],
    agentNotes: ["Use help before inventing memory file structure or command flags."],
    phase: "Phase 1"
  },
  {
    name: "init",
    purpose: "Scaffold memory files and agent instructions in a consuming repository.",
    usage: [
      "agent-memory init --yes",
      "agent-memory init --yes --package-manager npm",
      "agent-memory init --yes --package-manager bun",
      "agent-memory init --yes --agent codex",
      "agent-memory init --yes --agent generic",
      "agent-memory init --yes --agent codex --skill-location .agents",
      "agent-memory init --yes --install-hooks",
      "agent-memory init --yes --force"
    ],
    examples: ["agent-memory init --yes --agent codex", "agent-memory init --yes --agent codex --skill-location .agents", "agent-memory init --package-manager bun"],
    agentNotes: ["Safe to run repeatedly. Existing files are skipped unless --force is passed; AGENTS.md keeps local content and refreshes only the managed agent-memory section. Use --skill-location with exactly one --agent target."],
    phase: "Phase 2"
  },
  {
    name: "compile",
    purpose: "Compile canonical Markdown and YAML memory into repo-local SQLite.",
    usage: ["agent-memory compile", "agent-memory compile --db .agent-memory/memory.sqlite", "agent-memory compile --json", "agent-memory compile --verbose"],
    examples: ["agent-memory compile --json", "agent-memory compile --db .agent-memory/memory.sqlite"],
    agentNotes: ["SQLite is generated cache and should not be committed."],
    phase: "Phase 5"
  },
  {
    name: "validate",
    purpose: "Validate config, claims, graphs, indexes, recipes, and coverage rules.",
    usage: [
      "agent-memory validate",
      "agent-memory validate --json",
      "agent-memory validate --strict",
      "agent-memory validate --changed-files file1 file2"
    ],
    examples: ["agent-memory validate --json", "agent-memory validate --strict"],
    agentNotes: ["Validation prevents drift, broken references, missing evidence, and ambiguous memory."],
    phase: "Phase 4"
  },
  {
    name: "query",
    purpose: "Search compiled memory by text and metadata.",
    usage: [
      'agent-memory query "student oauth tenant"',
      'agent-memory query "student oauth tenant" --system auth',
      'agent-memory query "student oauth tenant" --status current',
      'agent-memory query "student oauth tenant" --limit 20',
      'agent-memory query "student oauth tenant" --include-stale',
      'agent-memory query "student oauth tenant" --json'
    ],
    examples: ['agent-memory query "oauth" --system auth', 'agent-memory query "oauth" --json'],
    agentNotes: ["Requires a compiled SQLite database. Prefer query over manually scanning memory files."],
    phase: "Phase 6"
  },
  {
    name: "show",
    purpose: "Show one compiled claim and optionally its graph-related claims.",
    usage: ["agent-memory show <claim-id>", "agent-memory show <claim-id> --include-related", "agent-memory show <claim-id> --depth 2", "agent-memory show <claim-id> --json"],
    examples: [
      "agent-memory show auth.student_oauth.uid_is_tenant_scoped",
      "agent-memory show auth.student_oauth.uid_is_tenant_scoped --include-related"
    ],
    agentNotes: ["Use show when you need exact claim metadata, source files, tags, or related constraints."],
    phase: "Phase 6"
  },
  {
    name: "system",
    purpose: "Summarize compiled memory for one system.",
    usage: ["agent-memory system <system>", "agent-memory system <system> --json"],
    examples: ["agent-memory system auth", "agent-memory system tenancy --json"],
    agentNotes: ["Use system before editing a subsystem to inspect its critical claims, recipes, watched files, and graph activity."],
    phase: "Phase 6"
  },
  {
    name: "recipes",
    purpose: "List, search, and show reusable workflow recipes.",
    usage: [
      "agent-memory recipes list",
      "agent-memory recipes list --include-inactive",
      'agent-memory recipes search "student oauth"',
      'agent-memory recipes search "student oauth" --changed-files src/auth.js',
      "agent-memory recipes search \"student oauth\" --limit 5",
      "agent-memory recipes search \"student oauth\" --include-inactive",
      "agent-memory recipes show recipe.auth.modify_student_oauth",
      "agent-memory recipes show recipe.auth.modify_student_oauth --json"
    ],
    examples: ['agent-memory recipes search "student oauth"', "agent-memory recipes show recipe.auth.modify_student_oauth"],
    agentNotes: ["Requires a compiled SQLite database. Search hides stale, deprecated, and rejected recipes unless --include-inactive is passed."],
    phase: "Phase 11"
  },
  {
    name: "plans",
    purpose: "Search plan templates and manage local generated plan runs.",
    usage: [
      "agent-memory plans templates list",
      "agent-memory plans templates show plan_template.auth.oauth_change",
      'agent-memory plans suggest --task "change student oauth provider"',
      'agent-memory plans new --task "change student oauth provider"',
      'agent-memory plans new --template plan_template.auth.oauth_change --task "change student oauth provider"',
      "agent-memory plans show plan_run.20260702.oauth_change.1234abcd",
      "agent-memory plans next plan_run.20260702.oauth_change.1234abcd",
      "agent-memory plans complete-stage plan_run.20260702.oauth_change.1234abcd --stage inspect --evidence \"tests passed\"",
      "agent-memory plans block-stage plan_run.20260702.oauth_change.1234abcd --stage inspect --reason \"waiting on API docs\"",
      "agent-memory plans finish plan_run.20260702.oauth_change.1234abcd --confirm-unresolved",
      "agent-memory plans prune --completed --older-than 7d",
      "agent-memory plans promote plan_run.20260702.oauth_change.1234abcd --to-template"
    ],
    examples: [
      'agent-memory plans suggest --task "change student oauth provider"',
      'agent-memory plans new --template plan_template.auth.oauth_change --task "change student oauth provider"',
      "agent-memory context --plan plan_run.20260702.oauth_change.1234abcd --stage inspect"
    ],
    agentNotes: ["Plan runs are generated local state under .agent-memory/plans. Finish or prune them instead of treating completed runs as durable memory."],
    phase: "Contextual Workflows Phase 4"
  },
  {
    name: "templates",
    purpose: "List, show, or copy built-in claim templates.",
    usage: [
      "agent-memory templates list",
      "agent-memory templates show claim:fact",
      "agent-memory templates show claim:constraint",
      "agent-memory templates copy claim:fact --to /tmp/fact.md",
      "agent-memory templates copy claim:fact --to /tmp/fact.md --force"
    ],
    examples: ["agent-memory templates list", "agent-memory templates show claim:constraint"],
    agentNotes: ["Use templates before creating claims so the durable memory shape stays consistent."],
    phase: "Phase 3"
  },
  {
    name: "new",
    purpose: "Create new memory artifacts from templates.",
    usage: [
      "agent-memory new claim --type fact --system auth --title \"Student OAuth UID is tenant scoped\"",
      "agent-memory new claim --interactive",
      "agent-memory new claim --type rule --system ci --severity critical",
      "agent-memory new claim --type fact --system auth --title \"Student OAuth UID is tenant scoped\" --source-file src/auth.js",
      "agent-memory new claim --type fact --system auth --title \"Student OAuth UID is tenant scoped\" --id auth.student_oauth.uid_is_tenant_scoped"
    ],
    examples: [
      "agent-memory new claim --type fact --system auth --title \"Student OAuth UID is tenant scoped\"",
      "agent-memory new claim --type constraint --system auth --id auth.ios_webview.cookies_not_reliable --title \"Cookies are not reliable in iOS webview\""
    ],
    agentNotes: ["Creates one Markdown file per claim and avoids overwriting existing claim files."],
    phase: "Phase 3"
  },
  {
    name: "context",
    purpose: "Build task-ready memory context for agent work.",
    usage: [
      'agent-memory context --task "fix student oauth"',
      "agent-memory context --changed-files file1 file2",
      "agent-memory context --git-diff",
      "agent-memory context --task \"fix auth\" --budget small|medium|full",
      "agent-memory context --task \"fix auth\" --depth 2",
      "agent-memory context --task \"fix auth\" --include-inferred",
      "agent-memory context --task \"fix auth\" --no-include-inferred",
      "agent-memory context --recipe recipe.auth.modify_student_oauth",
      "agent-memory context --plan plan_run.20260702.oauth_change.1234abcd --stage inspect",
      "agent-memory context --task \"fix auth\" --json"
    ],
    examples: ['agent-memory context --changed-files src/auth.js', "agent-memory context --git-diff"],
    agentNotes: ["Requires a compiled SQLite database. Run this before editing code in a memory-enabled repo."],
    phase: "Phase 7"
  },
  {
    name: "coverage",
    purpose: "Check whether changed watched files have related memory updates or valid waivers.",
    usage: [
      "agent-memory coverage --changed-files file1 file2",
      "agent-memory coverage --git-diff",
      "agent-memory coverage --git-diff --base origin/main",
      "agent-memory coverage --git-diff --json"
    ],
    examples: ["agent-memory coverage --changed-files src/auth.js", "agent-memory coverage --git-diff --base origin/main"],
    agentNotes: ["Returns exit code 6 when watched code changed without a related claim, index, recipe, or waiver."],
    phase: "Phase 9"
  },
  {
    name: "audit",
    purpose: "Audit changed memory for deterministic stale-claim risks.",
    usage: [
      "agent-memory audit --changed-files file1 file2",
      "agent-memory audit --git-diff",
      "agent-memory audit --git-diff --base origin/main",
      "agent-memory audit --git-diff --json"
    ],
    examples: ["agent-memory audit --changed-files docs/agent-memory/claims/auth/example.md", "agent-memory audit --git-diff --base origin/main"],
    agentNotes: ["Returns exit code 6 when changed memory overlaps active claims without an explicit review decision or stale markers are invalid."],
    phase: "Phase 9"
  },
  {
    name: "doctor",
    purpose: "Check whether the compiled SQLite database is present, fresh, and compatible.",
    usage: ["agent-memory doctor", "agent-memory doctor --json"],
    examples: ["agent-memory doctor", "agent-memory doctor --json"],
    agentNotes: ["Use doctor when retrieval commands fail or after switching branches."],
    phase: "Phase 8"
  },
  {
    name: "sync",
    purpose: "Refresh the memory database and run validation and health checks.",
    usage: ["agent-memory sync", "agent-memory sync --json"],
    examples: ["agent-memory sync", "bin/memory sync"],
    agentNotes: ["Use sync after pull, checkout, rebase, merge, or before agent work."],
    phase: "Phase 8"
  },
  {
    name: "upgrade",
    purpose: "Refresh generated repository support files while preserving local settings.",
    usage: [
      "agent-memory upgrade",
      "agent-memory upgrade --write",
      "agent-memory upgrade --write --force",
      "agent-memory upgrade --json"
    ],
    examples: ["agent-memory upgrade", "agent-memory upgrade --write"],
    agentNotes: ["Dry-run by default. Preserves config values, refreshes managed AGENTS.md and skill files, and warns before dropping unknown config fields."],
    phase: "Maintenance"
  },
  {
    name: "install-hooks",
    purpose: "Install non-blocking git hooks that run bin/memory sync after repository state changes.",
    usage: ["agent-memory install-hooks", "agent-memory install-hooks --force", "agent-memory install-hooks --json"],
    examples: ["agent-memory install-hooks", "agent-memory install-hooks --force"],
    agentNotes: ["Hooks warn but do not block git operations."],
    phase: "Phase 8"
  },
  {
    name: "ui",
    purpose: "Serve a local browser UI for inspecting and reviewing repository memory.",
    usage: ["agent-memory ui", "agent-memory ui --port 0", "agent-memory ui --host 127.0.0.1 --port 4317", "agent-memory ui --json"],
    examples: ["agent-memory ui", "agent-memory ui --port 0"],
    agentNotes: ["The UI binds locally by default and uses a session token for write actions."],
    phase: "Future UI"
  },
  {
    name: "install-skill",
    purpose: "Install agent-specific repository memory instructions from configured paths.",
    usage: [
      "agent-memory install-skill --agent codex",
      "agent-memory install-skill --agent generic",
      "agent-memory install-skill --agent codex --kind migration",
      "agent-memory install-skill --agent codex --location .codex",
      "agent-memory install-skill --agent generic --location .agents",
      "agent-memory install-skill --agent codex --location .agent-skills",
      "agent-memory install-skill --agent codex --path .codex/skills/repo-memory/SKILL.md",
      "agent-memory install-skill --agent codex --force",
      "agent-memory install-skill --agent generic --json"
    ],
    examples: ["agent-memory install-skill --agent codex", "agent-memory install-skill --agent codex --kind migration"],
    agentNotes: ["Use --location for roots like .codex, .agents, or .claude; migration skills write under repo-memory-migration."],
    phase: "Phase 10"
  },
  {
    name: "migrate-docs",
    purpose: "Plan or create current memory drafts from existing repository docs.",
    usage: [
      "agent-memory migrate-docs --from docs/canonical --classify",
      "agent-memory migrate-docs --from docs/canonical --classify --force",
      "agent-memory migrate-docs --system-map .agent-memory/migrations/docs-canonical.yaml",
      "agent-memory migrate-docs --system-map .agent-memory/migrations/docs-canonical.yaml --automatic",
      "agent-memory migrate-docs --from docs/legacy --system auth",
      "agent-memory migrate-docs --from docs/legacy --system auth --automatic",
      "agent-memory migrate-docs --from docs/legacy --system auth --automatic --force",
      "agent-memory migrate-docs --from docs/legacy --system auth --json"
    ],
    examples: [
      "agent-memory migrate-docs --from docs/canonical --classify",
      "agent-memory migrate-docs --system-map .agent-memory/migrations/docs-canonical.yaml --automatic",
      "agent-memory migrate-docs --from docs/legacy --system auth",
      "agent-memory migrate-docs --from docs/legacy --system auth --automatic"
    ],
    agentNotes: [
      "For broad folders, first run --classify, review or edit the generated system map, then run --system-map with --automatic.",
      "Rerunning --classify skips an existing system map unless --force is passed.",
      "The --system value is still required for focused single-system migrations; it is the lowercase memory namespace for generated claim IDs and paths.",
      "Automatic mode creates current, low-confidence drafts; agents must review and split them into precise atomic claims."
    ],
    phase: "Phase 10"
  },
  {
    name: "agent-manifest",
    purpose: "Return machine-readable command descriptions and repo-specific memory paths for agents.",
    usage: ["agent-memory agent-manifest", "agent-memory agent-manifest --json"],
    examples: ["agent-memory agent-manifest --json"],
    agentNotes: ["Use this when an agent needs a compact list of available memory commands."],
    phase: "Phase 10"
  }
];

export function renderHelp(topicName?: string): string {
  if (topicName) {
    const topic = TOPICS.find((candidate) => candidate.name === topicName);

    if (!topic) {
      throw new NotFoundError(`Unknown help topic: ${topicName}`, {
        details: [`Known topics: ${TOPICS.map((topic) => topic.name).join(", ")}`]
      });
    }

    return renderTopic(topic);
  }

  return [
    `${PACKAGE_NAME} ${PACKAGE_VERSION}`,
    "",
    "Repository-local agent memory based on atomic claims, graph relationships, recipes, and generated indexes.",
    "",
    "Usage:",
    "  agent-memory <command> [options]",
    "",
    "Available now:",
    "  help                 Show command help.",
    "  init                 Scaffold memory files and agent instructions in a consuming repository.",
    "  templates            List, show, and copy built-in templates.",
    "  new claim            Create a claim from a built-in template.",
    "  validate             Validate canonical memory files.",
    "  compile              Build the repo-local SQLite memory cache.",
    "  query                Search compiled claims.",
    "  show                 Show one compiled claim.",
    "  system               Summarize compiled memory for one system.",
    "  recipes              List, search, and show reusable workflow recipes.",
    "  plans                Search workflow templates and manage generated plan runs.",
    "  context              Build agent-ready task or file context.",
    "  coverage             Check watched-file memory coverage.",
    "  audit                Audit deterministic stale-claim risks.",
    "  doctor               Check compiled database health.",
    "  sync                 Compile, validate, and doctor memory.",
    "  upgrade              Refresh generated support files for a newer agent-memory version.",
    "  install-hooks        Install non-blocking git sync hooks.",
    "  ui                   Serve the local memory review UI.",
    "  install-skill        Install agent memory instructions.",
    "  migrate-docs         Plan or draft memory from existing docs.",
    "  agent-manifest       Print machine-readable agent command metadata.",
    "  --version            Print package version.",
    "",
    "Planned command groups:",
    "  governance",
    "",
    "Examples:",
    "  agent-memory help",
    "  agent-memory help context",
    "  agent-memory --version",
    "",
    "Agent Notes:",
    "  Canonical memory will live in docs/agent-memory; generated SQLite will live in .agent-memory/.",
    "  Do not treat SQLite as source of truth.",
    "  Use command help instead of inventing file formats."
  ].join("\n");
}

function renderTopic(topic: HelpTopic): string {
  return [
    `agent-memory ${topic.name}`,
    "",
    `Phase: ${topic.phase}`,
    "",
    "Purpose:",
    `  ${topic.purpose}`,
    "",
    "Usage:",
    ...topic.usage.map((line) => `  ${line}`),
    "",
    "Examples:",
    ...topic.examples.map((line) => `  ${line}`),
    "",
    "Agent Notes:",
    ...topic.agentNotes.map((line) => `  ${line}`)
  ].join("\n");
}
