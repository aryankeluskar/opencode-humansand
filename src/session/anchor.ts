import type { JSONObject, LanguageModelV3Prompt, SharedV3ProviderMetadata } from "@ai-sdk/provider"

export const ANCHOR_VERSION = 1

/**
 * Session state carried on assistant parts as `providerMetadata.<key>`. OpenCode persists it as the part's `native`
 * data and replays it as `providerOptions.<key>` on the next request for the same provider and model.
 */
export interface Anchor {
  readonly v: typeof ANCHOR_VERSION
  /** Ampersand session id. */
  readonly session: string
  /** Hash of the agent definition the session was created with (model, instructions, tools, ampersand options). */
  readonly agent: string
  /** Ampersand turn the step belonged to. */
  readonly turn: string
  /** `waiting` when the turn stopped for tool results, `completed` when it finished. */
  readonly status: "waiting" | "completed"
  /** Reasoning effort the session currently runs with, when the caller pinned one. */
  readonly effort?: "high" | "max"
  /** Present on tool-call parts only: the Ampersand `call_id`. */
  readonly call?: string
}

export interface FoundAnchor {
  readonly anchor: Anchor
  /** Index in the prompt of the assistant message carrying the anchor. */
  readonly index: number
  /** Ampersand turn id for every tool call OpenCode may answer, keyed by tool call id. */
  readonly callTurns: ReadonlyMap<string, string>
}

const isAnchor = (value: unknown): value is Anchor => {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    v.v === ANCHOR_VERSION &&
    typeof v.session === "string" &&
    typeof v.agent === "string" &&
    typeof v.turn === "string" &&
    (v.status === "waiting" || v.status === "completed")
  )
}

/** Find the most recent anchor in the prompt. Everything after the carrying assistant message is the delta. */
export function findAnchor(prompt: LanguageModelV3Prompt, key: string): FoundAnchor | undefined {
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const message = prompt[index]
    if (!message || message.role !== "assistant") continue
    let anchor: Anchor | undefined
    const callTurns = new Map<string, string>()
    for (let p = message.content.length - 1; p >= 0; p -= 1) {
      const part = message.content[p]
      if (!part) continue
      const candidate = part.providerOptions?.[key]
      if (!isAnchor(candidate)) continue
      if (part.type === "tool-call" && typeof candidate.call === "string") callTurns.set(part.toolCallId, candidate.turn)
      // Parts are emitted in order; the last one reflects the final state of the step.
      if (anchor === undefined) anchor = candidate
    }
    if (anchor === undefined) continue
    // Tool calls from earlier steps of the same session may still be unanswered (parallel calls across steps are
    // not possible with Ampersand, but a stale map entry is harmless).
    for (let back = index - 1; back >= 0; back -= 1) {
      const earlier = prompt[back]
      if (!earlier || earlier.role !== "assistant") continue
      for (const part of earlier.content) {
        if (part.type !== "tool-call") continue
        const candidate = part.providerOptions?.[key]
        if (isAnchor(candidate) && candidate.session === anchor.session && !callTurns.has(part.toolCallId)) {
          callTurns.set(part.toolCallId, candidate.turn)
        }
      }
    }
    return { anchor, index, callTurns }
  }
  return undefined
}

export function anchorMetadata(key: string, anchor: Anchor): SharedV3ProviderMetadata {
  const value: Record<string, string | number> = {
    v: anchor.v,
    session: anchor.session,
    agent: anchor.agent,
    turn: anchor.turn,
    status: anchor.status,
  }
  if (anchor.effort !== undefined) value.effort = anchor.effort
  if (anchor.call !== undefined) value.call = anchor.call
  return { [key]: value satisfies JSONObject }
}
