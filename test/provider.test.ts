import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { APICallError, type LanguageModelV3Prompt, type LanguageModelV3StreamPart, type SharedV3ProviderMetadata } from "@ai-sdk/provider"
import { createHumansand } from "../src/index.js"
import { MockAmpersand, type Reply } from "./mock.js"

const KEY = "humansand"

const tools = [
  { type: "function" as const, name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { type: "function" as const, name: "bash", description: "Run a command", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
]

const system = "You are a chief of staff."

const user = (text: string): LanguageModelV3Prompt[number] => ({ role: "user", content: [{ type: "text", text }] })

async function collect(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3StreamPart[]> {
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) return parts
    parts.push(value)
  }
}

const textOf = (parts: LanguageModelV3StreamPart[]) => parts.flatMap((p) => (p.type === "text-delta" ? [p.delta] : [])).join("")
const finishOf = (parts: LanguageModelV3StreamPart[]) => parts.find((p): p is Extract<LanguageModelV3StreamPart, { type: "finish" }> => p.type === "finish")
/** The anchor OpenCode would find: the last carrier part (text-end, tool-call or reasoning-end) of the step. */
const anchorOf = (parts: LanguageModelV3StreamPart[]) => {
  const part = [...parts].reverse().find((p) => p.type === "reasoning-end" || p.type === "tool-call" || p.type === "text-end")
  return (part && "providerMetadata" in part ? (part.providerMetadata as SharedV3ProviderMetadata)[KEY] : undefined) as Record<string, unknown> | undefined
}

/** Turn a step's stream parts into the assistant message OpenCode would replay (AI SDK bridge lowering). */
function assistantMessage(parts: LanguageModelV3StreamPart[]): LanguageModelV3Prompt[number] {
  const content: Extract<LanguageModelV3Prompt[number], { role: "assistant" }>["content"] = []
  const texts = new Map<string, number>()
  for (const part of parts) {
    if (part.type === "text-start") texts.set(part.id, content.push({ type: "text", text: "" }) - 1)
    if (part.type === "text-delta") {
      const index = texts.get(part.id)
      if (index !== undefined) {
        const existing = content[index]
        if (existing?.type === "text") content[index] = { type: "text", text: existing.text + part.delta }
      }
    }
    if (part.type === "text-end") {
      const index = texts.get(part.id)
      const existing = index === undefined ? undefined : content[index]
      if (index !== undefined && existing?.type === "text") content[index] = { ...existing, providerOptions: part.providerMetadata }
    }
    if (part.type === "reasoning-end") content.push({ type: "reasoning", text: "", providerOptions: part.providerMetadata })
    if (part.type === "tool-call") content.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: JSON.parse(part.input), providerOptions: part.providerMetadata })
  }
  return { role: "assistant", content: content.filter((p) => p.type !== "text" || p.text.length > 0) }
}

let mock: MockAmpersand
const start = (script: Reply[]) => {
  mock = new MockAmpersand({ script })
  return createHumansand({ apiKey: mock.apiKey, baseURL: mock.baseURL })
}

beforeEach(() => {
  delete process.env.HUMANSAND_API_KEY
  delete process.env.AMPERSAND_API_KEY
})
afterEach(() => mock?.stop())

describe("first step (CREATE)", () => {
  test("streams text, carries the anchor, reports context usage", async () => {
    const provider = start([{ text: "Hello from Ampersand" }])
    const model = provider("ampersand-v0.1")
    const { stream } = await model.doStream({ prompt: [{ role: "system", content: system }, user("hi")], tools })
    const parts = await collect(stream)
    expect(textOf(parts)).toBe("Hello from Ampersand")
    // The text part carries the anchor; no empty reasoning block is needed.
    expect(parts.some((p) => p.type === "reasoning-start")).toBe(false)
    const finish = finishOf(parts)
    expect(finish?.finishReason.unified).toBe("stop")
    expect(finish?.usage.inputTokens.total).toBeGreaterThan(0)
    expect(finish?.usage.outputTokens.total).toBe("Hello from Ampersand".length + 7)
    expect(finish?.usage.outputTokens.reasoning).toBe(7)
    const anchor = anchorOf(parts)
    expect(anchor).toMatchObject({ v: 1, status: "completed" })
    expect(anchor?.session).toMatch(/^sess_/)
    expect(anchor?.turn).toMatch(/^turn_/)
    const create = mock.requests.find((r) => r.method === "POST" && r.path === "/agents/sessions")
    expect(create).toBeDefined()
    const body = create!.body as { agent: { instructions: string; tools: unknown[]; ampersand: Record<string, unknown> }; input: Array<{ metadata: Record<string, string> }>; stream: boolean; environment: { type: string } }
    expect(body.environment.type).toBe("none")
    expect(body.stream).toBe(true)
    expect(body.agent.instructions).toBe(system)
    expect(body.agent.tools).toHaveLength(2)
    expect(body.agent.ampersand).toEqual({ compaction: "auto", allow_silent_completion: true })
    expect(body.input[0]!.metadata.sender).toBe("user")
    expect(body.input[0]!.metadata.channel).toBe("opencode")
    // The first step has no history: the message is live input, not a replay.
    expect(body.input[0]!.metadata.source).toBe("opencode-humansand")
    expect(create!.headers["openai-beta"]).toBe("agents=v1")
    expect(mock.requests.some((r) => r.path.endsWith("/context"))).toBe(true)
  })

  test("silent completion still carries an anchor", async () => {
    const provider = start([{}])
    const parts = await collect((await provider().doStream({ prompt: [user("do nothing")] })).stream)
    expect(textOf(parts)).toBe("")
    expect(parts.some((p) => p.type === "text-start")).toBe(false)
    expect(parts.some((p) => p.type === "reasoning-end")).toBe(true)
    expect(anchorOf(parts)?.status).toBe("completed")
    expect(finishOf(parts)?.finishReason.unified).toBe("stop")
  })

  test("tool calls finish with tool-calls and carry call ids", async () => {
    const provider = start([{ text: "Looking.", calls: [{ name: "read", args: { path: "a.txt" } }] }])
    const parts = await collect((await provider().doStream({ prompt: [user("read a.txt")], tools })).stream)
    const call = parts.find((p): p is Extract<LanguageModelV3StreamPart, { type: "tool-call" }> => p.type === "tool-call")
    expect(call?.toolName).toBe("read")
    expect(JSON.parse(call!.input)).toEqual({ path: "a.txt" })
    const meta = call!.providerMetadata![KEY] as Record<string, unknown>
    expect(meta.call).toBe(call!.toolCallId)
    expect(meta.status).toBe("waiting")
    expect(finishOf(parts)?.finishReason.unified).toBe("tool-calls")
    expect(anchorOf(parts)?.status).toBe("waiting")
    const order = parts.map((p) => p.type)
    expect(order.indexOf("tool-input-start")).toBeLessThan(order.indexOf("tool-call"))
    expect(order.indexOf("text-end")).toBeLessThan(order.indexOf("finish"))
  })
})

describe("following steps (CONTINUE)", () => {
  test("tool results are posted as tool_result events to the same session; no new session is created", async () => {
    const provider = start([{ calls: [{ name: "read", args: { path: "a.txt" } }] }, { text: "a.txt says hi" }])
    const model = provider()
    const prompt: LanguageModelV3Prompt = [{ role: "system", content: system }, user("read a.txt")]
    const step1 = await collect((await model.doStream({ prompt, tools })).stream)
    const call = step1.find((p): p is Extract<LanguageModelV3StreamPart, { type: "tool-call" }> => p.type === "tool-call")!
    const assistant = assistantMessage(step1)
    const toolMessage: LanguageModelV3Prompt[number] = { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: "read", output: { type: "text", value: "hi" } }] }
    const step2 = await collect((await model.doStream({ prompt: [...prompt, assistant, toolMessage], tools })).stream)
    expect(textOf(step2)).toBe("a.txt says hi")
    expect(finishOf(step2)?.finishReason.unified).toBe("stop")
    // The API replays item.done for the answered call; it must not come back as a new tool call.
    expect(step2.some((p) => p.type === "tool-call" || p.type === "tool-input-start")).toBe(false)
    const creates = mock.requests.filter((r) => r.method === "POST" && r.path === "/agents/sessions")
    expect(creates).toHaveLength(1)
    const post = mock.requests.find((r) => r.method === "POST" && r.path.endsWith("/events"))!
    expect(post.headers["idempotency-key"]).toMatch(/^[a-f0-9]{48}$/)
    const events = (post.body as { events: Array<Record<string, unknown>> }).events
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "agent.session.input.tool_result", call_id: call.toolCallId, success: true, output: "hi" })
    expect(events[0]!.turn_id).toBe((call.providerMetadata![KEY] as { turn: string }).turn)
    // SSE subscription was opened before the POST
    const getIdx = mock.requests.findIndex((r) => r.method === "GET" && r.path.endsWith("/events"))
    const postIdx = mock.requests.indexOf(post)
    expect(getIdx).toBeGreaterThan(-1)
    expect(getIdx).toBeLessThan(postIdx)
    expect(anchorOf(step2)?.session).toBe((call.providerMetadata![KEY] as { session: string }).session)
  })

  test("a new user message after a completed turn becomes one message event; a host retry is new work", async () => {
    const provider = start([{ text: "first" }, { text: "second" }])
    const model = provider()
    const prompt: LanguageModelV3Prompt = [user("one")]
    const step1 = await collect((await model.doStream({ prompt })).stream)
    const next: LanguageModelV3Prompt = [...prompt, assistantMessage(step1), user("two")]
    const step2 = await collect((await model.doStream({ prompt: next, providerOptions: { humansand: { sender: "aryan", channel: "tui" } } })).stream)
    expect(textOf(step2)).toBe("second")
    const post = mock.requests.find((r) => r.method === "POST" && r.path.endsWith("/events"))!
    const events = (post.body as { events: Array<{ type: string; input?: Array<{ content: Array<{ text: string }>; metadata: Record<string, string> }> }> }).events
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe("agent.session.input.message")
    expect(events[0]!.input).toHaveLength(1)
    expect(events[0]!.input![0]!.content[0]!.text).toBe("two")
    expect(events[0]!.input![0]!.metadata).toMatchObject({ sender: "aryan", channel: "tui", source: "opencode-humansand" })
    const idA = events[0]!.input![0]!.metadata.id
    // Same delta again (host retry after a dropped stream) must start a new turn: fresh key, fresh message id.
    mock.script.push({ text: "third" })
    const step3 = await collect((await model.doStream({ prompt: next, providerOptions: { humansand: { sender: "aryan", channel: "tui" } } })).stream)
    expect(textOf(step3)).toBe("third")
    const posts = mock.requests.filter((r) => r.method === "POST" && r.path.endsWith("/events"))
    expect(posts).toHaveLength(2)
    expect(posts[1]!.headers["idempotency-key"]).not.toBe(posts[0]!.headers["idempotency-key"])
    expect((posts[1]!.body as { events: typeof events }).events[0]!.input![0]!.metadata.id).not.toBe(idA)
  })

  test("a waiting turn gets cancelled when the user sends a message instead of tool results", async () => {
    const provider = start([{ calls: [{ name: "bash", args: { command: "rm -rf /" } }] }, { text: "ok, skipping" }])
    const model = provider()
    const prompt: LanguageModelV3Prompt = [user("clean up")]
    const step1 = await collect((await model.doStream({ prompt, tools })).stream)
    const step2 = await collect((await model.doStream({ prompt: [...prompt, assistantMessage(step1), user("no, don't")], tools })).stream)
    expect(textOf(step2)).toBe("ok, skipping")
    expect(finishOf(step2)?.finishReason.unified).toBe("stop")
    // The cancel goes alone (the API refuses input until the turn's terminal event), then the message.
    const posts = mock.requests.filter((r) => r.method === "POST" && r.path.endsWith("/events"))
    expect(posts.map((p) => (p.body as { events: Array<{ type: string }> }).events.map((e) => e.type))).toEqual([
      ["agent.session.input.cancel"],
      ["agent.session.input.message"],
    ])
    expect(posts[1]!.headers["idempotency-key"]).toBeDefined()
    // the cancelled turn's events must not have produced a finish
    expect(step2.filter((p) => p.type === "finish")).toHaveLength(1)
  })

  test("effort change updates the session in place instead of recreating it", async () => {
    const provider = start([{ text: "a" }, { text: "b" }])
    const model = provider()
    const prompt: LanguageModelV3Prompt = [user("one")]
    const step1 = await collect((await model.doStream({ prompt, providerOptions: { humansand: { reasoningEffort: "high" } } })).stream)
    expect(anchorOf(step1)?.effort).toBe("high")
    await collect((await model.doStream({ prompt: [...prompt, assistantMessage(step1), user("two")], providerOptions: { humansand: { reasoningEffort: "xhigh" } } })).stream)
    const update = mock.requests.find((r) => r.method === "POST" && /^\/agents\/sessions\/sess_\d+$/.test(r.path))
    expect(update?.body).toEqual({ agent: { reasoning: { effort: "max" } } })
    expect(mock.requests.filter((r) => r.method === "POST" && r.path === "/agents/sessions")).toHaveLength(1)
  })

  test("changing the tool set recreates the session with a full replay and deletes the old one", async () => {
    const provider = start([{ text: "a" }, { text: "b" }])
    const model = provider()
    const prompt: LanguageModelV3Prompt = [{ role: "system", content: system }, user("one")]
    const step1 = await collect((await model.doStream({ prompt, tools })).stream)
    const oldSession = anchorOf(step1)?.session as string
    const step2 = await collect((await model.doStream({ prompt: [...prompt, assistantMessage(step1), user("two")], tools: tools.slice(0, 1) })).stream)
    expect(textOf(step2)).toBe("b")
    const creates = mock.requests.filter((r) => r.method === "POST" && r.path === "/agents/sessions")
    expect(creates).toHaveLength(2)
    const replay = (creates[1]!.body as { input: Array<{ content: Array<{ text: string }>; metadata: Record<string, string> }> }).input
    expect(replay.map((m) => [m.metadata.sender, m.content[0]!.text])).toEqual([
      ["user", "one"],
      ["assistant", "a"],
      ["user", "two"],
    ])
    // History is tagged as a replay; the new message that triggered this step is live.
    expect(replay.map((m) => m.metadata.source)).toEqual(["opencode-humansand/replay", "opencode-humansand/replay", "opencode-humansand"])
    expect(anchorOf(step2)?.session).not.toBe(oldSession)
    await Bun.sleep(20)
    expect(mock.requests.some((r) => r.method === "DELETE" && r.path === `/agents/sessions/${oldSession}`)).toBe(true)
  })

  test("a session that disappeared server-side is recreated transparently", async () => {
    const provider = start([{ text: "a" }, { text: "b" }])
    const model = provider()
    const prompt: LanguageModelV3Prompt = [user("one")]
    const step1 = await collect((await model.doStream({ prompt })).stream)
    mock.sessions.get(anchorOf(step1)?.session as string)!.deleted = true
    const step2 = await collect((await model.doStream({ prompt: [...prompt, assistantMessage(step1), user("two")] })).stream)
    expect(textOf(step2)).toBe("b")
    expect(mock.requests.filter((r) => r.method === "POST" && r.path === "/agents/sessions")).toHaveLength(2)
  })
})

describe("errors", () => {
  test("turn failure surfaces as a non-retryable APICallError mentioning context length", async () => {
    const provider = start([{ fail: { code: "context_length_exceeded", message: "too long" } }])
    const parts = await collect((await provider().doStream({ prompt: [user("x")] })).stream)
    const error = parts.find((p): p is Extract<LanguageModelV3StreamPart, { type: "error" }> => p.type === "error")
    expect(error).toBeDefined()
    expect(error!.error).toBeInstanceOf(APICallError)
    const api = error!.error as APICallError
    expect(api.message).toContain("context length exceeded")
    expect(api.isRetryable).toBe(false)
  })

  test("HTTP 401 becomes an APICallError with status", async () => {
    const provider = start([])
    const bad = createHumansand({ apiKey: "wrong", baseURL: mock.baseURL })
    await expect(bad().doStream({ prompt: [user("x")] })).rejects.toMatchObject({ statusCode: 401, isRetryable: false })
    void provider
  })

  test("oversized tool schemas fail fast with the offending names", async () => {
    const provider = start([])
    const huge = { type: "function" as const, name: "huge", inputSchema: { type: "object", properties: Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [`p${i}`, { type: "string", description: "x".repeat(20) }])) } }
    await expect(provider().doStream({ prompt: [user("x")], tools: [huge] })).rejects.toThrow(/"huge": schema is \d+ bytes/)
    expect(mock.requests).toHaveLength(0)
  })

  test("invalid tool names are rejected before the request", async () => {
    const provider = start([])
    await expect(provider().doStream({ prompt: [user("x")], tools: [{ type: "function", name: "my tool!", inputSchema: {} }] })).rejects.toThrow(/name must match/)
  })

  test("missing key raises LoadAPIKeyError", async () => {
    const provider = createHumansand({ baseURL: "http://127.0.0.1:1" })
    await expect(provider().doStream({ prompt: [user("x")] })).rejects.toThrow(/HUMANSAND_API_KEY/)
  })
})

describe("doGenerate and settings", () => {
  test("doGenerate aggregates text, tool calls and metadata", async () => {
    const provider = start([{ text: "Reading", calls: [{ name: "read", args: { path: "b" } }] }])
    const result = await provider().doGenerate({ prompt: [user("go")], tools })
    expect(result.content.map((c) => c.type)).toEqual(["text", "tool-call"])
    expect(result.finishReason.unified).toBe("tool-calls")
    expect((result.providerMetadata?.[KEY] as { status: string }).status).toBe("waiting")
  })

  test("unsupported sampling options become warnings; compaction and silent completion settings reach the agent", async () => {
    const provider = start([{ text: "x" }])
    const model = createHumansand({ apiKey: mock.apiKey, baseURL: mock.baseURL, serverCompaction: "disabled", allowSilentCompletion: false })()
    const { stream } = await model.doStream({ prompt: [user("x")], temperature: 0.2, toolChoice: { type: "required" } })
    const parts = await collect(stream)
    const startPart = parts[0] as Extract<LanguageModelV3StreamPart, { type: "stream-start" }>
    expect(startPart.warnings.map((w) => (w.type === "unsupported" ? w.feature : w.type))).toEqual(["temperature", "toolChoice.required"])
    const body = mock.requests[0]!.body as { agent: { ampersand: Record<string, unknown> } }
    expect(body.agent.ampersand).toEqual({ compaction: "disabled", allow_silent_completion: false })
  })

  const readUntil = async (stream: ReadableStream<LanguageModelV3StreamPart>, type: LanguageModelV3StreamPart["type"]) => {
    const reader = stream.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done || value.type === type) return reader
    }
  }
  const cancelEvent = () => {
    const cancel = mock.requests.find((r) => r.method === "POST" && r.path.endsWith("/events"))
    return (cancel?.body as { events: Array<{ type: string }> } | undefined)?.events[0]?.type
  }

  test("cancelling the stream mid-turn cancels the Ampersand turn", async () => {
    const provider = start([{ text: "thinking about it for a while", calls: [{ name: "read", args: {} }] }])
    const { stream } = await provider().doStream({ prompt: [user("x")], tools })
    const reader = await readUntil(stream, "text-start")
    await reader.cancel()
    await Bun.sleep(20)
    expect(cancelEvent()).toBe("agent.session.input.cancel")
  })

  test("the abort signal cancels the Ampersand turn", async () => {
    const provider = start([{ text: "thinking about it for a while", calls: [{ name: "read", args: {} }] }])
    const controller = new AbortController()
    const { stream } = await provider().doStream({ prompt: [user("x")], tools, abortSignal: controller.signal })
    await readUntil(stream, "text-start")
    controller.abort()
    await Bun.sleep(20)
    expect(cancelEvent()).toBe("agent.session.input.cancel")
  })

  test("no cancel is sent after the step finished", async () => {
    const provider = start([{ text: "done" }])
    const { stream } = await provider().doStream({ prompt: [user("x")] })
    const reader = await readUntil(stream, "finish")
    await reader.cancel()
    await Bun.sleep(20)
    expect(cancelEvent()).toBeUndefined()
  })
})
