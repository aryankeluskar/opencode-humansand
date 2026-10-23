/**
 * Live smoke test against the real Ampersand API (needs HUMANSAND_API_KEY or AMPERSAND_API_KEY).
 *   bun --env-file=.env e2e/live.ts
 * Three steps: a plain reply, a tool call, the tool result (CONTINUE), then a second user turn (CONTINUE).
 * Stays well under the normal tier's 10 work requests per minute.
 */
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { createHumansand } from "../src/index.ts"

const KEY = "humansand"
const provider = createHumansand({ sender: "aryan", channel: "live-test" })
const model = provider("ampersand-v0.1")

async function run(label: string, prompt: LanguageModelV3Prompt, tools?: Parameters<typeof model.doStream>[0]["tools"]) {
  console.log(`\n=== ${label}`)
  const started = Date.now()
  const { stream } = await model.doStream({ prompt, tools })
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    parts.push(value)
    if (value.type === "text-delta") process.stdout.write(value.delta)
    else if (value.type === "tool-call") console.log(`\n[tool-call] ${value.toolName} ${value.input}`)
    else if (value.type === "finish") console.log(`\n[finish] ${value.finishReason.unified} usage=${JSON.stringify(value.usage)}`)
    else if (value.type === "error") console.log(`\n[error] ${(value.error as Error).message}`)
    else if (value.type === "stream-start" && value.warnings.length) console.log(`[warnings] ${JSON.stringify(value.warnings)}`)
  }
  console.log(`[${Date.now() - started} ms] parts: ${parts.map((p) => p.type).join(" ")}`)
  return parts
}

/** Rebuild the assistant message the way OpenCode's AI SDK bridge replays it. */
function assistant(parts: LanguageModelV3StreamPart[]): LanguageModelV3Prompt[number] {
  const content: Extract<LanguageModelV3Prompt[number], { role: "assistant" }>["content"] = []
  const texts = new Map<string, number>()
  for (const part of parts) {
    if (part.type === "text-start") texts.set(part.id, content.push({ type: "text", text: "" }) - 1)
    if (part.type === "text-delta") {
      const i = texts.get(part.id)
      const existing = i === undefined ? undefined : content[i]
      if (i !== undefined && existing?.type === "text") content[i] = { ...existing, text: existing.text + part.delta }
    }
    if (part.type === "text-end") {
      const i = texts.get(part.id)
      const existing = i === undefined ? undefined : content[i]
      if (i !== undefined && existing?.type === "text") content[i] = { ...existing, providerOptions: part.providerMetadata }
    }
    if (part.type === "reasoning-end") content.push({ type: "reasoning", text: "", providerOptions: part.providerMetadata })
    if (part.type === "tool-call") content.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: JSON.parse(part.input), providerOptions: part.providerMetadata })
  }
  return { role: "assistant", content: content.filter((p) => p.type !== "text" || p.text.length > 0) }
}

const tools = [
  {
    type: "function" as const,
    name: "get_time",
    description: "Returns the current time in the user's timezone.",
    inputSchema: { type: "object", properties: { timezone: { type: "string", description: "IANA timezone, e.g. America/Los_Angeles" } }, required: ["timezone"] },
  },
]

const system = "You are a terse assistant used in a connectivity test. Follow instructions literally."
const p1: LanguageModelV3Prompt = [{ role: "system", content: system }, { role: "user", content: [{ type: "text", text: "Reply with exactly: pong" }] }]
const s1 = await run("step 1: plain reply (CREATE)", p1, tools)
const a1 = assistant(s1)
const anchor1 = a1.content.map((p) => p.providerOptions?.[KEY]).filter(Boolean).at(-1)
console.log("anchor:", JSON.stringify(anchor1))

const p2: LanguageModelV3Prompt = [...p1, a1, { role: "user", content: [{ type: "text", text: "Call get_time for America/Los_Angeles, then tell me the time in one short sentence." }] }]
const s2 = await run("step 2: tool call (CONTINUE)", p2, tools)
const a2 = assistant(s2)
const call = s2.find((p): p is Extract<LanguageModelV3StreamPart, { type: "tool-call" }> => p.type === "tool-call")
if (!call) {
  console.log("no tool call; stopping")
  process.exit(1)
}
const p3: LanguageModelV3Prompt = [...p2, a2, { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: "2026-10-22T17:41:00-07:00" } }] }]
const s3 = await run("step 3: tool result (CONTINUE)", p3, tools)
const a3 = assistant(s3)
const p4: LanguageModelV3Prompt = [...p3, a3, { role: "user", content: [{ type: "text", text: "Thanks. What was the first thing I asked you to reply with?" }] }]
await run("step 4: second turn (CONTINUE)", p4, tools)
