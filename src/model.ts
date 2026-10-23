import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3Prompt,
  type LanguageModelV3StreamPart,
  type LanguageModelV3StreamResult,
  type LanguageModelV3Usage,
  type SharedV3Warning,
} from "@ai-sdk/provider"
import { generateId } from "@ai-sdk/provider-utils"
import type { Client, EventStream } from "./ampersand/client.js"
import type { AgentOverrides, FunctionTool, SessionCreate } from "./ampersand/types.js"
import { agentHash, checkTools, toFunctionTool, TOOLS_TOTAL_LIMIT, TOOL_SCHEMA_LIMIT } from "./session/agent.js"
import { lowerForCreate, type Lowered, type Stamp } from "./session/lower.js"
import { plan, type ContinuePlan, type Plan } from "./session/plan.js"
import { callSettings, PROVIDER, type CallSettings, type HumansandSettings } from "./settings.js"
import { translate } from "./stream/translate.js"

export interface ModelConfig {
  readonly client: Client
  readonly settings: HumansandSettings
  readonly key: string
}

interface Prepared {
  readonly prompt: LanguageModelV3Prompt
  readonly settings: CallSettings
  readonly agent: string
  readonly agentOverrides: AgentOverrides
  readonly plan: Plan
  readonly stamp: Stamp
  readonly nonce: string
  readonly warnings: SharedV3Warning[]
}

const leadingInstructions = (prompt: LanguageModelV3Prompt): string | undefined => {
  const parts: string[] = []
  for (const message of prompt) {
    if (message.role !== "system") break
    parts.push(message.content)
  }
  return parts.length ? parts.join("\n\n") : undefined
}

const isGone = (error: unknown): boolean => error instanceof APICallError && (error.statusCode === 404 || error.statusCode === 410)

const EMPTY_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
}

export class HumansandLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly provider = PROVIDER
  readonly supportedUrls: Record<string, RegExp[]> = {}

  constructor(
    readonly modelId: string,
    private readonly config: ModelConfig,
  ) {}

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const prepared = this.prepare(options)
    const started = await this.start(prepared, options.abortSignal)
    const client = this.config.client
    let finished = false
    let cancelled = false
    let sessionId = started.session
    // Stop the Ampersand turn when the host goes away mid-step (stream cancel or abort signal), so it does not keep
    // spending credit. The cancel request deliberately ignores the (already aborted) caller signal.
    const cancelTurn = async () => {
      if (cancelled || finished || !sessionId) return
      cancelled = true
      await client.postEvents(sessionId, [{ type: "agent.session.input.cancel" }], undefined).catch(() => {})
    }
    options.abortSignal?.addEventListener("abort", () => void cancelTurn(), { once: true })
    const parts = translate(started.stream, {
      client,
      key: this.config.key,
      agent: prepared.agent,
      effort: prepared.settings.effort,
      session: started.session,
      answered: started.answered,
      staleTurn: started.staleTurn,
      contextUsage: this.config.settings.contextUsage ?? true,
      onSession: (id) => {
        sessionId = id
      },
    })
    const readable = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: prepared.warnings })
      },
      async pull(controller) {
        const next = await parts.next()
        if (next.done) {
          controller.close()
          return
        }
        const part = next.value
        if (part.type === "finish" || part.type === "error") finished = true
        controller.enqueue(part)
      },
      async cancel() {
        // Close the SSE read first so the generator can unwind, then stop the turn.
        started.stream.close()
        await parts.return(undefined).catch(() => {})
        await cancelTurn()
      },
    })
    return { stream: readable, request: { body: started.request }, response: { headers: started.stream.headers } }
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { stream, request, response } = await this.doStream(options)
    const content: LanguageModelV3Content[] = []
    const text = new Map<string, { text: string; index: number }>()
    const reasoning = new Map<string, number>()
    let finish: Extract<LanguageModelV3StreamPart, { type: "finish" }> | undefined
    let warnings: SharedV3Warning[] = []
    const reader = stream.getReader()
    while (true) {
      const { value: part, done } = await reader.read()
      if (done) break
      switch (part.type) {
        case "stream-start":
          warnings = part.warnings
          break
        case "text-start":
          text.set(part.id, { text: "", index: content.push({ type: "text", text: "" }) - 1 })
          break
        case "text-delta": {
          const entry = text.get(part.id)
          if (entry) {
            entry.text += part.delta
            content[entry.index] = { type: "text", text: entry.text }
          }
          break
        }
        case "reasoning-start":
          reasoning.set(part.id, content.push({ type: "reasoning", text: "", ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}) }) - 1)
          break
        case "reasoning-end": {
          const index = reasoning.get(part.id)
          if (index !== undefined && part.providerMetadata) content[index] = { type: "reasoning", text: "", providerMetadata: part.providerMetadata }
          break
        }
        case "tool-call":
          content.push(part)
          break
        case "finish":
          finish = part
          break
        case "error":
          throw part.error
        default:
          break
      }
    }
    return {
      content,
      finishReason: finish?.finishReason ?? { unified: "other", raw: undefined },
      usage: finish?.usage ?? EMPTY_USAGE,
      ...(finish?.providerMetadata ? { providerMetadata: finish.providerMetadata } : {}),
      request: { body: request?.body },
      response: { headers: response?.headers ?? {} },
      warnings,
    }
  }

  private prepare(options: LanguageModelV3CallOptions): Prepared {
    const key = this.config.key
    const settings = callSettings(this.config.settings, options, key)
    const warnings = [...settings.warnings]
    const tools: FunctionTool[] = []
    for (const tool of options.tools ?? []) {
      if (tool.type !== "function") {
        warnings.push({ type: "unsupported", feature: `provider tool ${tool.id}` })
        continue
      }
      tools.push(toFunctionTool(tool.name, tool.description, tool.inputSchema))
    }
    const budget = checkTools(tools)
    if (budget.issues.length > 0 || budget.total > TOOLS_TOTAL_LIMIT) {
      const lines = budget.issues.map((issue) =>
        issue.reason === "name"
          ? `- "${issue.name}": name must match ^[a-zA-Z0-9_-]{1,96}$`
          : `- "${issue.name}": schema is ${issue.bytes} bytes (limit ${TOOL_SCHEMA_LIMIT})`,
      )
      if (budget.total > TOOLS_TOTAL_LIMIT) lines.push(`- all tools together: ${budget.total} bytes (limit ${TOOLS_TOTAL_LIMIT})`)
      throw new APICallError({
        message: `Tool definitions exceed Ampersand limits:\n${lines.join("\n")}\nReduce the tool set (OpenCode: enable Code Mode or disable MCP servers for this agent).`,
        url: this.config.client.baseURL,
        requestBodyValues: { tools: tools.map((tool) => tool.name) },
        isRetryable: false,
      })
    }
    const ampersand = { compaction: settings.compaction, allow_silent_completion: settings.allowSilentCompletion }
    const instructions = leadingInstructions(options.prompt)
    const agent = agentHash({ model: this.modelId, instructions, tools, ampersand })
    const stamp: Stamp = { sender: settings.sender, channel: settings.channel, extra: settings.metadata }
    const nonce = generateId().slice(0, 8)
    const stepPlan = plan({ prompt: options.prompt, key, agent, stamp, effort: settings.effort, nonce })
    const agentOverrides: AgentOverrides = {
      model: this.modelId,
      instructions: instructions ?? null,
      tools,
      reasoning: { effort: settings.effort ?? null },
      ampersand,
    }
    warnings.push(...(stepPlan.kind === "create" ? stepPlan.lowered.warnings : stepPlan.warnings))
    return { prompt: options.prompt, settings, agent, agentOverrides, plan: stepPlan, stamp, nonce, warnings }
  }

  private async start(
    prepared: Prepared,
    signal: AbortSignal | undefined,
  ): Promise<{ stream: EventStream; request: unknown; session: string | undefined; answered: Set<string>; staleTurn: string | undefined }> {
    const client = this.config.client
    let lowered: Lowered | undefined
    let orphan: string | undefined
    if (prepared.plan.kind === "continue") {
      const resumed = await this.continueSession(prepared.plan, signal)
      if (resumed !== undefined) {
        const answered = new Set(prepared.plan.events.flatMap((event) => (event.type === "agent.session.input.tool_result" ? [event.call_id] : [])))
        const staleTurn = prepared.plan.events[0]?.type === "agent.session.input.cancel" ? prepared.plan.found.anchor.turn : undefined
        return { ...resumed, session: prepared.plan.found.anchor.session, answered, staleTurn }
      }
      // The session is gone server-side (expired or deleted): start over with a full replay.
      lowered = lowerForCreate(prepared.prompt, prepared.stamp, prepared.nonce)
    } else {
      lowered = prepared.plan.lowered
      orphan = prepared.plan.orphan?.session
    }
    const body: SessionCreate = {
      environment: { type: "none" },
      agent: prepared.agentOverrides,
      input: lowered.messages.length ? lowered.messages : [{ role: "user", content: [{ type: "input_text", text: "" }] }],
      metadata: { source: "opencode-humansand", ...(prepared.settings.sessionMetadata ?? {}) },
      stream: true,
    }
    const stream = await client.createSessionStream(body, signal)
    if (orphan !== undefined) void client.deleteSession(orphan).catch(() => {})
    return { stream, request: body, session: undefined, answered: new Set(), staleTurn: undefined }
  }

  private async continueSession(step: ContinuePlan, signal: AbortSignal | undefined): Promise<{ stream: EventStream; request: unknown } | undefined> {
    const client = this.config.client
    const session = step.found.anchor.session
    if (step.effortUpdate !== undefined) {
      try {
        await client.updateSession(session, { agent: { reasoning: { effort: step.effortUpdate } } }, signal)
      } catch (error) {
        if (isGone(error)) return undefined
        throw error
      }
    }
    let stream: EventStream
    try {
      stream = await client.openEvents(session, signal)
    } catch (error) {
      if (isGone(error)) return undefined
      throw error
    }
    try {
      await client.postEvents(session, step.events, step.idempotencyKey, signal)
    } catch (error) {
      stream.close()
      if (isGone(error)) return undefined
      throw error
    }
    return { stream, request: { session, events: step.events } }
  }
}
