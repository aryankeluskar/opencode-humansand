import type { JSONSchema7 } from "@ai-sdk/provider"
import type { AmpersandOptions, FunctionTool, JsonObject } from "../ampersand/types.js"
import { canonical, sha256 } from "./hash.js"

export interface AgentDefinition {
  readonly model: string
  readonly instructions: string | undefined
  readonly tools: ReadonlyArray<FunctionTool>
  readonly ampersand: AmpersandOptions
}

/** Identity of an Ampersand session's frozen configuration. Effort is excluded: it is updatable in place. */
export function agentHash(agent: AgentDefinition): string {
  return sha256(
    canonical({
      model: agent.model,
      instructions: agent.instructions ?? "",
      tools: agent.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", parameters: tool.parameters })),
      ampersand: { compaction: agent.ampersand.compaction ?? "auto", allow_silent_completion: agent.ampersand.allow_silent_completion ?? true },
    }),
  )
}

export const TOOL_NAME = /^[a-zA-Z0-9_-]{1,96}$/
export const TOOL_SCHEMA_LIMIT = 32 * 1024
export const TOOLS_TOTAL_LIMIT = 128 * 1024

export interface ToolBudgetIssue {
  readonly name: string
  readonly reason: "name" | "size"
  readonly bytes?: number
}

/** Validate tools against Ampersand's documented limits before the request leaves the process. */
export function checkTools(tools: ReadonlyArray<FunctionTool>): { readonly issues: ToolBudgetIssue[]; readonly total: number } {
  const issues: ToolBudgetIssue[] = []
  let total = 0
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) issues.push({ name: tool.name, reason: "name" })
    const bytes = Buffer.byteLength(JSON.stringify(tool.parameters), "utf8")
    total += bytes
    if (bytes > TOOL_SCHEMA_LIMIT) issues.push({ name: tool.name, reason: "size", bytes })
  }
  return { issues, total }
}

export function toFunctionTool(name: string, description: string | undefined, schema: JSONSchema7 | undefined): FunctionTool {
  const parameters = (schema && typeof schema === "object" ? schema : { type: "object", properties: {} }) as JsonObject
  return description === undefined
    ? { type: "function", name, parameters }
    : { type: "function", name, description, parameters }
}
