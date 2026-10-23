import type { LanguageModelV3Message, LanguageModelV3Prompt, LanguageModelV3ToolResultOutput, SharedV3Warning } from "@ai-sdk/provider"
import type { EventMetadata, InputMessage, InputText, ToolResultInputEvent } from "../ampersand/types.js"
import { shortHash } from "./hash.js"

export const REPLAY_SOURCE = "opencode-humansand/replay"
export const LIVE_SOURCE = "opencode-humansand"

/** Request bodies are capped at 4 MiB; leave headroom for the agent definition and envelope. */
export const BODY_BUDGET = 4 * 1024 * 1024
export const BODY_HEADROOM = 256 * 1024
/** A single replayed tool output larger than this is trimmed before the global budget is applied. */
export const TOOL_OUTPUT_SOFT_CAP = 200 * 1024

export interface Stamp {
  readonly sender: string
  readonly channel: string
  readonly extra: Readonly<Record<string, unknown>> | undefined
}

export interface Lowered {
  readonly instructions: string | undefined
  readonly messages: InputMessage[]
  readonly warnings: SharedV3Warning[]
}

const text = (value: string): InputText => ({ type: "input_text", text: value })

const metadata = (source: string, id: string, sender: string, channel: string, extra?: Readonly<Record<string, unknown>>): EventMetadata =>
  ({ ...(extra as EventMetadata | undefined), source, id, sender, channel }) as EventMetadata

/** Render a tool result output as text the way an agent would read it. */
export function renderToolOutput(output: LanguageModelV3ToolResultOutput): { readonly text: string; readonly success: boolean } {
  switch (output.type) {
    case "text":
      return { text: output.value, success: true }
    case "json":
      return { text: JSON.stringify(output.value), success: true }
    case "error-text":
      return { text: output.value, success: false }
    case "error-json":
      return { text: JSON.stringify(output.value), success: false }
    case "execution-denied":
      return { text: output.reason ?? "Tool execution was denied.", success: false }
    case "content": {
      const parts = output.value.map((item) => {
        if (item.type === "text") return item.text
        if (item.type === "image-data" || item.type === "image-url") return "[image omitted]"
        if (item.type === "file-data" || item.type === "file-url") return `[file omitted${"filename" in item && item.filename ? `: ${item.filename}` : ""}]`
        return ""
      })
      return { text: parts.filter((p) => p.length > 0).join("\n"), success: true }
    }
  }
}

const userText = (message: Extract<LanguageModelV3Message, { role: "user" }>, warnings: SharedV3Warning[]): string => {
  const chunks: string[] = []
  for (const part of message.content) {
    if (part.type === "text") chunks.push(part.text)
    else {
      warnings.push({ type: "unsupported", feature: "file input", details: `Dropped ${part.mediaType} attachment; Ampersand input is text-only in this bridge.` })
    }
  }
  return chunks.join("\n")
}

/**
 * Lower the whole prompt for `POST /agents/sessions`. Leading system messages become `instructions`; everything else
 * becomes `role: user` messages with a `sender` so the model can tell who said what.
 */
export function lowerForCreate(prompt: LanguageModelV3Prompt, stamp: Stamp, nonce: string): Lowered {
  const warnings: SharedV3Warning[] = []
  const messages: InputMessage[] = []
  const system: string[] = []
  let n = 0
  let conversationStarted = false
  const push = (sender: string, body: string) => {
    if (body.length === 0) return
    n += 1
    messages.push({ role: "user", content: [text(body)], metadata: metadata(REPLAY_SOURCE, `${nonce}-${n}`, sender, stamp.channel, stamp.extra) })
  }
  for (const message of prompt) {
    switch (message.role) {
      case "system":
        if (!conversationStarted) system.push(message.content)
        else push("system", message.content)
        break
      case "user":
        conversationStarted = true
        push(stamp.sender, userText(message, warnings))
        break
      case "assistant": {
        conversationStarted = true
        const lines: string[] = []
        for (const part of message.content) {
          if (part.type === "text") lines.push(part.text)
          else if (part.type === "tool-call") lines.push(`Called ${part.toolName} with ${JSON.stringify(part.input ?? {})}`)
          else if (part.type === "tool-result") {
            if (lines.length) push("assistant", lines.splice(0).join("\n"))
            push("tool", `Result of ${part.toolName}: ${renderToolOutput(part.output).text}`)
          }
          // reasoning and files are not replayed
        }
        if (lines.length) push("assistant", lines.join("\n"))
        break
      }
      case "tool":
        conversationStarted = true
        for (const part of message.content) {
          if (part.type !== "tool-result") continue
          const rendered = renderToolOutput(part.output)
          push("tool", `Result of ${part.toolName}${rendered.success ? "" : " (error)"}: ${rendered.text}`)
        }
        break
    }
  }
  const instructions = system.length ? system.join("\n\n") : undefined
  return { instructions, messages: fitBudget(messages, BODY_BUDGET - BODY_HEADROOM - Buffer.byteLength(instructions ?? "", "utf8"), warnings), warnings }
}

export interface Delta {
  readonly results: ToolResultInputEvent[]
  readonly messages: InputMessage[]
  readonly warnings: SharedV3Warning[]
  /** Tool call ids answered in this delta. */
  readonly answered: string[]
}

/** Lower only what came after the anchor message. Ids are derived from `scope`, which the planner makes unique per attempt. */
export function lowerDelta(
  prompt: LanguageModelV3Prompt,
  after: number,
  stamp: Stamp,
  turnFor: (toolCallId: string) => string | undefined,
  scope: string,
): Delta {
  const warnings: SharedV3Warning[] = []
  const results: ToolResultInputEvent[] = []
  const messages: InputMessage[] = []
  const answered: string[] = []
  let n = 0
  const push = (sender: string, body: string) => {
    if (body.length === 0) return
    n += 1
    const id = shortHash(`${scope}:${n}:${body}`)
    messages.push({ role: "user", content: [text(body)], metadata: metadata(LIVE_SOURCE, id, sender, stamp.channel, stamp.extra) })
  }
  for (let index = after + 1; index < prompt.length; index += 1) {
    const message = prompt[index]
    if (!message) continue
    switch (message.role) {
      case "system":
        push("system", message.content)
        break
      case "user":
        push(stamp.sender, userText(message, warnings))
        break
      case "tool":
        for (const part of message.content) {
          if (part.type !== "tool-result") continue
          const turn = turnFor(part.toolCallId)
          if (turn === undefined) {
            // The call did not come from this Ampersand session (e.g. injected by the host); tell the model as text.
            const rendered = renderToolOutput(part.output)
            push("tool", `Result of ${part.toolName}${rendered.success ? "" : " (error)"}: ${rendered.text}`)
            continue
          }
          const rendered = renderToolOutput(part.output)
          answered.push(part.toolCallId)
          results.push(
            rendered.success
              ? { type: "agent.session.input.tool_result", turn_id: turn, call_id: part.toolCallId, success: true, output: rendered.text }
              : { type: "agent.session.input.tool_result", turn_id: turn, call_id: part.toolCallId, success: false, error: rendered.text },
          )
        }
        break
      case "assistant": {
        // An assistant message after the anchor was produced by another model (model switch mid-session) or was
        // injected. Replay it as text so the server-side history stays truthful.
        const lines: string[] = []
        for (const part of message.content) {
          if (part.type === "text") lines.push(part.text)
          else if (part.type === "tool-call") lines.push(`Called ${part.toolName} with ${JSON.stringify(part.input ?? {})}`)
        }
        push("assistant", lines.join("\n"))
        break
      }
    }
  }
  return { results: fitResults(results, warnings), messages, warnings, answered }
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")

const truncate = (value: string, max: number): string => {
  if (Buffer.byteLength(value, "utf8") <= max) return value
  const head = Math.floor(max * 0.6)
  const tail = Math.floor(max * 0.3)
  return `${value.slice(0, head)}\n…[truncated ${value.length - head - tail} characters by opencode-humansand]…\n${value.slice(-tail)}`
}

/** Shrink replayed tool outputs, then drop the oldest messages, until the payload fits. */
function fitBudget(messages: InputMessage[], budget: number, warnings: SharedV3Warning[]): InputMessage[] {
  let out = messages.map((message) => {
    if (message.metadata?.sender !== "tool") return message
    const part = message.content[0]
    if (!part || part.type !== "input_text" || Buffer.byteLength(part.text, "utf8") <= TOOL_OUTPUT_SOFT_CAP) return message
    return { ...message, content: [text(truncate(part.text, TOOL_OUTPUT_SOFT_CAP))] }
  })
  if (bytes(out) <= budget) return out
  let dropped = 0
  while (out.length > 2 && bytes(out) > budget) {
    out = out.slice(1)
    dropped += 1
  }
  if (dropped > 0) {
    warnings.push({ type: "other", message: `Dropped the ${dropped} oldest messages to fit Ampersand's 4 MiB request limit when replaying history.` })
    out = [
      { role: "user", content: [text(`[${dropped} earlier messages omitted by opencode-humansand to fit the request size limit]`)], metadata: metadata(REPLAY_SOURCE, "omitted", "system", "opencode") },
      ...out,
    ]
  }
  return out
}

function fitResults(results: ToolResultInputEvent[], warnings: SharedV3Warning[]): ToolResultInputEvent[] {
  const perResult = Math.floor((BODY_BUDGET - BODY_HEADROOM) / Math.max(1, results.length))
  return results.map((result) => {
    const value = result.success ? result.output : result.error
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") <= perResult) return result
    warnings.push({ type: "other", message: `Truncated the output of tool call ${result.call_id} to fit Ampersand's request size limit.` })
    return result.success ? { ...result, output: truncate(value, perResult) } : { ...result, error: truncate(value, perResult) }
  })
}
