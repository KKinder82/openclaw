import type { AgentTool } from "@earendil-works/pi-agent-core";
import { toToolDefinitions } from "../pi-tool-definition-adapter.js";

// We always pass tools via `customTools` so our policy filtering, sandbox integration,
// and extended toolset remain consistent across providers.
type AnyAgentTool = AgentTool;

// 将 SDK 工具拆分为适合嵌入式 PI agent 使用的工具定义格式。
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }): {
  customTools: ReturnType<typeof toToolDefinitions>;
} {
  const { tools } = options;
  return {
    customTools: toToolDefinitions(tools),
  };
}
