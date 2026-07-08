export interface AgentToolPackageBoundary {
  packageName: "@jurgen1c/agent-tools";
  role: "agent-tools-meta-package";
  includedPackages: readonly AgentToolCliPackage[];
  runtimeCoupling: "none";
}

export type AgentToolCliPackageName = "@jurgen1c/agent-memory-cli" | "@jurgen1c/agentflow-cli";
export type AgentToolBinaryName = "agent-memory" | "agentflow";

export interface AgentToolCliPackage {
  packageName: AgentToolCliPackageName;
  binaryName: AgentToolBinaryName;
  role: "repository-memory-cli" | "workflow-runtime-cli";
  packageStatus: "published" | "workspace-private";
  installPackageName: "@jurgen1c/agent-memory-cli";
  installCommand: string;
}

export const agentToolCliPackages = [
  {
    packageName: "@jurgen1c/agent-memory-cli",
    binaryName: "agent-memory",
    role: "repository-memory-cli",
    packageStatus: "published",
    installPackageName: "@jurgen1c/agent-memory-cli",
    installCommand: "npm install --save-dev @jurgen1c/agent-memory-cli"
  },
  {
    packageName: "@jurgen1c/agentflow-cli",
    binaryName: "agentflow",
    role: "workflow-runtime-cli",
    packageStatus: "workspace-private",
    installPackageName: "@jurgen1c/agent-memory-cli",
    installCommand: "npm install --save-dev @jurgen1c/agent-memory-cli"
  }
] as const satisfies readonly AgentToolCliPackage[];

export const agentToolPackageBoundary: AgentToolPackageBoundary = {
  packageName: "@jurgen1c/agent-tools",
  role: "agent-tools-meta-package",
  includedPackages: agentToolCliPackages,
  runtimeCoupling: "none"
};
