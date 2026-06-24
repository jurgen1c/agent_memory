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
    agentNotes: ["Planned for Phase 6. Prefer query over manually scanning memory files."],
    phase: "Phase 6 planned"
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
    usage: ['agent-memory context --task "fix student oauth"'],
    examples: ['agent-memory context --changed-files src/auth.js', "agent-memory context --git-diff"],
    agentNotes: ["Planned for Phase 7. Run this before editing code in a memory-enabled repo."],
    phase: "Phase 7 planned"
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
    "  --version            Print package version.",
    "",
    "Planned command groups:",
    "  query, show, system, context, doctor, sync, coverage, install-hooks, install-skill, agent-manifest, governance",
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
