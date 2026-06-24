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
    purpose: "Scaffold memory files in a consuming repository.",
    usage: [
      "agent-memory init --yes",
      "agent-memory init --yes --package-manager npm",
      "agent-memory init --yes --package-manager bun",
      "agent-memory init --yes --agent codex",
      "agent-memory init --yes --agent generic",
      "agent-memory init --yes --install-hooks"
    ],
    examples: ["agent-memory init --yes --agent codex", "agent-memory init --package-manager bun"],
    agentNotes: ["Safe to run repeatedly. Existing files are skipped unless --force is passed."],
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
    usage: ['agent-memory query "student oauth tenant"'],
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
    name: "templates",
    purpose: "List, show, or copy built-in claim templates.",
    usage: [
      "agent-memory templates list",
      "agent-memory templates show claim:fact",
      "agent-memory templates show claim:constraint",
      "agent-memory templates copy claim:fact --to /tmp/fact.md"
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
      "agent-memory new claim --type rule --system ci --severity critical"
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
      "agent-memory context --task \"fix auth\" --json"
    ],
    examples: ['agent-memory context --changed-files src/auth.js', "agent-memory context --git-diff"],
    agentNotes: ["Requires a compiled SQLite database. Run this before editing code in a memory-enabled repo."],
    phase: "Phase 7"
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
    "  init                 Scaffold memory files in a consuming repository.",
    "  templates            List, show, and copy built-in templates.",
    "  new claim            Create a claim from a built-in template.",
    "  validate             Validate canonical memory files.",
    "  compile              Build the repo-local SQLite memory cache.",
    "  query                Search compiled claims.",
    "  show                 Show one compiled claim.",
    "  system               Summarize compiled memory for one system.",
    "  context              Build agent-ready task or file context.",
    "  --version            Print package version.",
    "",
    "Planned command groups:",
    "  doctor, sync, coverage, install-hooks, install-skill, agent-manifest, governance",
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
