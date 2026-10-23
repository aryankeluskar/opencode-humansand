import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import type { InputEvent, InputMessage, ReasoningEffort } from "../ampersand/types.js"
import { findAnchor, type Anchor, type FoundAnchor } from "./anchor.js"
import { sha256 } from "./hash.js"
import { lowerDelta, lowerForCreate, type Lowered, type Stamp } from "./lower.js"

export interface CreatePlan {
  readonly kind: "create"
  readonly lowered: Lowered
  /** Session to delete once the new one exists. */
  readonly orphan: Anchor | undefined
  readonly reason: "no-anchor" | "agent-changed"
}

export interface ContinuePlan {
  readonly kind: "continue"
  readonly found: FoundAnchor
  readonly events: InputEvent[]
  readonly idempotencyKey: string
  readonly warnings: Lowered["warnings"]
  /** Effort to apply with `POST /agents/sessions/{id}` before posting events. */
  readonly effortUpdate: ReasoningEffort | undefined
}

export type Plan = CreatePlan | ContinuePlan

export interface PlanInput {
  readonly prompt: LanguageModelV3Prompt
  readonly key: string
  readonly agent: string
  readonly stamp: Stamp
  readonly effort: ReasoningEffort | undefined
  readonly nonce: string
}

export function plan(input: PlanInput): Plan {
  const found = findAnchor(input.prompt, input.key)
  if (found === undefined) {
    return { kind: "create", lowered: lowerForCreate(input.prompt, input.stamp, input.nonce), orphan: undefined, reason: "no-anchor" }
  }
  if (found.anchor.agent !== input.agent) {
    return { kind: "create", lowered: lowerForCreate(input.prompt, input.stamp, input.nonce), orphan: found.anchor, reason: "agent-changed" }
  }
  const anchor = found.anchor
  const scope = `${anchor.session}:${anchor.turn}`
  const delta = lowerDelta(
    input.prompt,
    found.index,
    input.stamp,
    (id) => found.callTurns.get(id) ?? (anchor.status === "waiting" ? anchor.turn : undefined),
    scope,
  )
  const events: InputEvent[] = []
  // A waiting turn that gets a new message instead of tool results must be cancelled, or the message queues behind it.
  if (anchor.status === "waiting" && delta.results.length === 0) events.push({ type: "agent.session.input.cancel" })
  events.push(...delta.results)
  if (delta.messages.length > 0) events.push({ type: "agent.session.input.message", input: delta.messages })
  if (events.length === 0) {
    // The host asked for another step without new input (e.g. a retry after a dropped stream). Ampersand needs an
    // event to start a turn; a system-sent nudge keeps the server history truthful about what happened.
    delta.warnings.push({ type: "other", message: "No new input since the last Ampersand turn; sent a system 'Continue.' nudge." })
    const nudge: InputMessage = {
      role: "user",
      content: [{ type: "input_text", text: "Continue." }],
      metadata: { source: "opencode-humansand", id: sha256(`${scope}:nudge`).slice(0, 24), sender: "system", channel: input.stamp.channel },
    }
    events.push({ type: "agent.session.input.message", input: [nudge] })
  }
  const ids = delta.messages.map((message: InputMessage) => message.metadata?.id ?? "")
  const idempotencyKey = sha256(`${scope}|${delta.answered.join(",")}|${ids.join(",")}|${events[0]?.type ?? ""}`).slice(0, 48)
  const effortUpdate = input.effort !== undefined && input.effort !== anchor.effort ? input.effort : undefined
  return { kind: "continue", found, events, idempotencyKey, warnings: delta.warnings, effortUpdate }
}
