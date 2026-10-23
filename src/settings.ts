import type { JSONObject, LanguageModelV3CallOptions, SharedV3Warning } from "@ai-sdk/provider"
import { loadApiKey, type FetchFunction } from "@ai-sdk/provider-utils"
import type { ReasoningEffort } from "./ampersand/types.js"

export interface HumansandSettings {
  /** Bearer token. Defaults to `HUMANSAND_API_KEY`, then `AMPERSAND_API_KEY`. */
  readonly apiKey?: string | undefined
  /** Defaults to `https://ampersand.humansand.ai/v1`. */
  readonly baseURL?: string | undefined
  readonly headers?: Record<string, string | undefined> | undefined
  readonly fetch?: FetchFunction | undefined
  /** Ampersand server-side compaction. Default `auto`. */
  readonly compaction?: "auto" | "disabled" | undefined
  /** Whether the agent may finish a turn without text or a tool call. Default `true`. */
  readonly allowSilentCompletion?: boolean | undefined
  /** `sender` stamped on user messages. Default `user`. */
  readonly sender?: string | undefined
  /** `channel` stamped on user messages. Default `opencode`. */
  readonly channel?: string | undefined
  /** Key under which per-part state travels in `providerMetadata` / `providerOptions`. Default `humansand`. */
  readonly metadataKey?: string | undefined
  /** Fetch `GET /context` after every step for the context meter. Default `true`. */
  readonly contextUsage?: boolean | undefined
  /** Provider name an AI SDK host may pass; unused. */
  readonly name?: string | undefined
}

export interface CallSettings {
  readonly effort: ReasoningEffort | undefined
  readonly compaction: "auto" | "disabled"
  readonly allowSilentCompletion: boolean
  readonly sender: string
  readonly channel: string
  readonly metadata: Readonly<Record<string, unknown>> | undefined
  readonly sessionMetadata: Readonly<Record<string, string>> | undefined
  readonly warnings: SharedV3Warning[]
}

export const PROVIDER = "humansand"
export const ENV_KEYS = ["HUMANSAND_API_KEY", "AMPERSAND_API_KEY"] as const

export function resolveApiKey(settings: HumansandSettings): () => string {
  return () =>
    loadApiKey({
      apiKey: settings.apiKey ?? process.env[ENV_KEYS[1]],
      environmentVariableName: ENV_KEYS[0],
      apiKeyParameterName: "apiKey",
      description: "humans& Ampersand",
    })
}

const EFFORTS: Record<string, ReasoningEffort> = {
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined)

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** Merge provider-level settings with per-call `providerOptions.<key>`; unsupported sampling settings become warnings. */
export function callSettings(settings: HumansandSettings, options: LanguageModelV3CallOptions, key: string): CallSettings {
  const warnings: SharedV3Warning[] = []
  const raw = (options.providerOptions?.[key] ?? {}) as JSONObject
  const effortName = str(raw.reasoningEffort) ?? str(raw.effort)
  let effort: ReasoningEffort | undefined
  if (effortName !== undefined) {
    effort = EFFORTS[effortName]
    if (effort === undefined) warnings.push({ type: "other", message: `Unknown reasoning effort "${effortName}"; Ampersand supports "high" and "max".` })
    else if (effort !== effortName) warnings.push({ type: "compatibility", feature: "reasoningEffort", details: `"${effortName}" mapped to Ampersand "${effort}".` })
  }
  for (const name of ["temperature", "topP", "topK", "presencePenalty", "frequencyPenalty", "seed", "stopSequences", "maxOutputTokens"] as const) {
    if (options[name] !== undefined) warnings.push({ type: "unsupported", feature: name })
  }
  if (options.responseFormat !== undefined && options.responseFormat.type !== "text") warnings.push({ type: "unsupported", feature: "responseFormat" })
  if (options.toolChoice !== undefined && options.toolChoice.type !== "auto") warnings.push({ type: "unsupported", feature: `toolChoice.${options.toolChoice.type}` })
  const compaction = raw.compaction === "disabled" || settings.compaction === "disabled" ? "disabled" : "auto"
  const allowSilentCompletion = typeof raw.allowSilentCompletion === "boolean" ? raw.allowSilentCompletion : (settings.allowSilentCompletion ?? true)
  const sessionMetadataRaw = record(raw.sessionMetadata)
  const sessionMetadata =
    sessionMetadataRaw === undefined
      ? undefined
      : Object.fromEntries(Object.entries(sessionMetadataRaw).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  return {
    effort,
    compaction,
    allowSilentCompletion,
    sender: str(raw.sender) ?? settings.sender ?? "user",
    channel: str(raw.channel) ?? settings.channel ?? "opencode",
    metadata: record(raw.metadata),
    sessionMetadata,
    warnings,
  }
}
