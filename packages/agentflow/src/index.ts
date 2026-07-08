import type { AgentToolPackageBoundary } from "../../agent-tools/src";

export interface AgentflowPackageBoundary {
  packageName: "@jurgen1c/agentflow";
  role: "workflow-runtime";
  sharedToolsPackage: AgentToolPackageBoundary["packageName"];
}

export const agentflowPackageBoundary: AgentflowPackageBoundary = {
  packageName: "@jurgen1c/agentflow",
  role: "workflow-runtime",
  sharedToolsPackage: "@jurgen1c/agent-tools"
};
