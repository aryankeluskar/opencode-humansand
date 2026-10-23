import type { LanguageModelV3StreamPart, LanguageModelV3Usage, SharedV3ProviderMetadata } from "@ai-sdk/provider"
import type { Client, EventStream } from "../ampersand/client.js"
import { streamFailure, turnFailure } from "../ampersand/errors.js"
import { isSessionEvent, isTurnEvent, type FunctionRequiredAction, type ServerEvent, type TokenUsage } from "../ampersand/types.js"
import { anchorMetadata, type Anchor } from "../session/anchor.js"

export interface TranslateContext {
  readonly client: Client
  readonly key: string
  readonly agent: string
  readonly effort: Anchor["effort"]
  /** Known session id (CONTINUE) or undefined until `agent.session.created` arrives (CREATE). */
  readonly session: string | undefined
  /** Tool call ids answered by the request that started this step; a `requires_action` listing only these is stale. */
  readonly answered: ReadonlySet<string>
  /** Turn cancelled by this step; its trailing events are ignored. */
  readonly staleTurn: string | undefined
  /** Skip `GET /context` (saves one API request per step). */
  readonly contextUsage: boolean
  /** Called as soon as the session id is known (immediately for CONTINUE, on `agent.session.created` for CREATE). */
  readonly onSession?: (sessionId: string) => void
}

export interface StepOutcome {
  readonly session: string
  readonly turn: string
  readonly status: Anchor["status"]
}

const usageFrom = (usage: TokenUsage | null | undefined, context: number | null | undefined): LanguageModelV3Usage => {
  const input = typeof context === "number" ? context : usage?.input_tokens
  const raw: Record<string, number | null> = {
    context_input_tokens: typeof context === "number" ? context : null,
    turn_input_tokens: usage?.input_tokens ?? null,
    turn_cached_tokens: usage?.input_tokens_details?.cached_tokens ?? null,
    turn_output_tokens: usage?.output_tokens ?? null,
    turn_reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens ?? null,
    turn_total_tokens: usage?.total_tokens ?? null,
  }
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: {
      total: usage?.output_tokens,
      text: usage === undefined || usage === null ? undefined : usage.output_tokens - (usage.output_tokens_details?.reasoning_tokens ?? 0),
      reasoning: usage?.output_tokens_details?.reasoning_tokens,
    },
    raw,
  }
}

/**
 * Translate one Ampersand step (from the first event after our input until the turn waits or completes) into AI SDK
 * stream parts. The generator returns once a `finish` part was emitted or an error part was yielded.
 */
export async function* translate(stream: EventStream, ctx: TranslateContext): AsyncGenerator<LanguageModelV3StreamPart, StepOutcome | undefined> {
  let session = ctx.session
  let turn: string | undefined
  const openText = new Set<string>()
  const openCalls = new Set<string>()
  const emittedCalls = new Set<string>()
  const textId = (itemId: string, contentIndex: number) => `${itemId}:${contentIndex}`

  const noteSession = (id: string | undefined) => {
    if (id === undefined || id.length === 0 || id === session) return
    session = id
    ctx.onSession?.(id)
  }
  const isStale = (turnId: string | undefined) => turnId !== undefined && turnId === ctx.staleTurn
  const noteTurn = (turnId: string | undefined) => {
    if (turnId === undefined || isStale(turnId)) return
    turn = turnId
  }
  const anchor = (status: Anchor["status"], call?: string): SharedV3ProviderMetadata =>
    anchorMetadata(ctx.key, {
      v: 1,
      session: session ?? "",
      agent: ctx.agent,
      turn: turn ?? "",
      status,
      ...(ctx.effort === undefined ? {} : { effort: ctx.effort }),
      ...(call === undefined ? {} : { call }),
    })

  function* closeText(): Generator<LanguageModelV3StreamPart> {
    for (const id of openText) yield { type: "text-end", id }
    openText.clear()
  }

  function* emitCall(callId: string, name: string, args: unknown): Generator<LanguageModelV3StreamPart> {
    if (emittedCalls.has(callId)) return
    emittedCalls.add(callId)
    const input = JSON.stringify(args ?? {})
    if (!openCalls.has(callId)) yield { type: "tool-input-start", id: callId, toolName: name }
    openCalls.delete(callId)
    yield { type: "tool-input-delta", id: callId, delta: input }
    yield { type: "tool-input-end", id: callId }
    yield { type: "tool-call", toolCallId: callId, toolName: name, input, providerMetadata: anchor("waiting", callId) }
  }

  function* finish(status: Anchor["status"], usage: LanguageModelV3Usage): Generator<LanguageModelV3StreamPart> {
    yield* closeText()
    const id = `humansand-anchor-${turn ?? "none"}`
    yield { type: "reasoning-start", id, providerMetadata: anchor(status) }
    yield { type: "reasoning-end", id, providerMetadata: anchor(status) }
    yield {
      type: "finish",
      finishReason: status === "waiting" ? { unified: "tool-calls", raw: "requires_action" } : { unified: "stop", raw: "completed" },
      usage,
      providerMetadata: anchor(status),
    }
  }

  const context = async (): Promise<number | null> => {
    if (session === undefined || !ctx.contextUsage) return null
    try {
      return (await ctx.client.getContext(session)).input_tokens
    } catch {
      return null
    }
  }

  const outcome = (status: Anchor["status"]): StepOutcome | undefined =>
    session === undefined || turn === undefined ? undefined : { session, turn, status }

  try {
    for await (const event of iterate(stream)) {
      if (isSessionEvent(event)) {
        noteSession(event.session.id)
        if (event.type === "agent.session.failed") {
          yield* closeText()
          yield { type: "error", error: streamFailure(stream.url, event.session.error ?? "session failed", "session_failed") }
          return undefined
        }
        if (event.type === "agent.session.requires_action") {
          const pending = (event.session.required_actions ?? []).filter(
            (action: FunctionRequiredAction) => !isStale(action.turn_id) && !ctx.answered.has(action.call_id),
          )
          if (pending.length === 0) continue
          for (const action of pending) {
            noteTurn(action.turn_id)
            yield* emitCall(action.call_id, action.name, action.arguments)
          }
          yield* finish("waiting", usageFrom(undefined, await context()))
          return outcome("waiting")
        }
        continue
      }
      if (isTurnEvent(event)) {
        noteSession(event.session_id)
        if (isStale(event.turn_id)) continue
        noteTurn(event.turn_id)
        if (event.type === "agent.session.turn.completed") {
          yield* finish("completed", usageFrom(event.usage ?? event.turn.usage, await context()))
          return outcome("completed")
        }
        if (event.type === "agent.session.turn.failed") {
          yield* closeText()
          yield { type: "error", error: turnFailure(stream.url, session ?? "", event.turn_id, event.turn.error) }
          return undefined
        }
        if (event.type === "agent.session.turn.cancelled") {
          yield* closeText()
          yield {
            type: "finish",
            finishReason: { unified: "other", raw: "cancelled" },
            usage: usageFrom(event.turn.usage, null),
            providerMetadata: anchor("completed"),
          }
          return outcome("completed")
        }
        continue
      }
      switch (event.type) {
        case "agent.session.turn.item.added": {
          noteSession(event.session_id)
          if (isStale(event.turn_id)) break
          noteTurn(event.turn_id)
          const item = event.item
          if (item.type === "function_call" && !emittedCalls.has(item.call_id)) {
            openCalls.add(item.call_id)
            yield { type: "tool-input-start", id: item.call_id, toolName: item.name }
          }
          break
        }
        case "agent.session.turn.item.done": {
          noteSession(event.session_id)
          if (isStale(event.turn_id)) break
          noteTurn(event.turn_id)
          const item = event.item
          if (item.type === "function_call") {
            yield* emitCall(item.call_id, item.name, item.arguments)
            break
          }
          for (const id of [...openText]) {
            if (!id.startsWith(`${item.id}:`)) continue
            openText.delete(id)
            yield { type: "text-end", id }
          }
          break
        }
        case "agent.session.turn.output_text.delta": {
          noteSession(event.session_id)
          if (isStale(event.turn_id)) break
          noteTurn(event.turn_id)
          const id = textId(event.item_id, event.content_index)
          if (!openText.has(id)) {
            openText.add(id)
            yield { type: "text-start", id }
          }
          if (event.delta.length > 0) yield { type: "text-delta", id, delta: event.delta }
          break
        }
        case "agent.session.turn.output_text.done":
        case "agent.session.turn.content_part.done": {
          noteSession(event.session_id)
          if (isStale(event.turn_id)) break
          const id = textId(event.item_id, event.content_index)
          if (openText.has(id)) {
            openText.delete(id)
            yield { type: "text-end", id }
            break
          }
          // Text that arrived without deltas; emit it whole.
          const text = event.type === "agent.session.turn.output_text.done" ? event.text : event.part.text
          if (text.length > 0 && event.type === "agent.session.turn.output_text.done") {
            yield { type: "text-start", id }
            yield { type: "text-delta", id, delta: text }
            yield { type: "text-end", id }
          }
          break
        }
        case "error": {
          yield* closeText()
          yield { type: "error", error: streamFailure(stream.url, event.error.message, event.error.code) }
          return undefined
        }
        default:
          break
      }
    }
    // Closed by the consumer (abort): end quietly.
    if (stream.signal.aborted) return undefined
    // Stream ended without a terminal event (server closed the connection). Let the host retry.
    yield* closeText()
    yield { type: "error", error: streamFailure(stream.url, "event stream ended before the turn settled", "stream_ended") }
    return undefined
  } finally {
    stream.close()
  }
}

/** Iterate the SSE events; a transport failure after the consumer closed the stream is not an error. */
async function* iterate(stream: EventStream): AsyncGenerator<ServerEvent> {
  try {
    for await (const event of stream.events) yield event
  } catch (error) {
    if (stream.signal.aborted) return
    throw error
  }
}
