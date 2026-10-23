/**
 * In-process mock of the Ampersand Agents API, faithful to the parts the bridge touches: session create with SSE,
 * events GET (SSE) / POST (202), context, retrieve/update/delete, auth and beta headers, idempotency keys, turn
 * lifecycle with `requires_action` and `turn.completed`.
 */
import type { FunctionTool, InputEvent, InputMessage, SessionCreate, TokenUsage, TurnError } from "../src/ampersand/types.js"

export interface Reply {
  readonly text?: string
  readonly calls?: ReadonlyArray<{ readonly name: string; readonly args: Record<string, unknown> }>
  readonly fail?: TurnError
}

export interface Recorded {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

interface Session {
  readonly id: string
  readonly agent: SessionCreate["agent"]
  status: "idle" | "in_progress" | "requires_action" | "failed"
  history: Array<{ kind: "message"; message: InputMessage } | { kind: "tool_result"; turn: string; call: string; success: boolean; output: string | null }>
  turns: Map<string, { id: string; status: string; usage: TokenUsage | null; calls: Map<string, { name: string; args: Record<string, unknown> }> }>
  currentTurn: string | undefined
  required: Array<{ type: "function_call"; turn_id: string; call_id: string; name: string; arguments: Record<string, unknown> }>
  subscribers: Set<(event: Record<string, unknown>) => void>
  contextTokens: number | null
  metadata: Record<string, string>
  effort: string | null | undefined
  deleted: boolean
}

export interface MockOptions {
  readonly apiKey?: string
  readonly script: Reply[]
  /** Fixed port (default: random free port). */
  readonly port?: number
  /** Called after every request is recorded. */
  readonly onRequest?: (request: Recorded) => void
}

export class MockAmpersand {
  readonly requests: Recorded[] = []
  readonly sessions = new Map<string, Session>()
  readonly idempotency = new Map<string, number>()
  readonly script: Reply[]
  private readonly server: ReturnType<typeof Bun.serve>
  private counter = 0
  readonly apiKey: string

  constructor(options: MockOptions) {
    this.script = [...options.script]
    this.apiKey = options.apiKey ?? "test-key"
    this.onRequest = options.onRequest
    this.server = Bun.serve({ port: options.port ?? 0, fetch: (request) => this.handle(request) })
  }

  private readonly onRequest: ((request: Recorded) => void) | undefined

  get baseURL(): string {
    return `http://127.0.0.1:${this.server.port}/v1`
  }

  stop(): void {
    this.server.stop(true)
  }

  private id(prefix: string): string {
    this.counter += 1
    return `${prefix}_${this.counter.toString().padStart(4, "0")}`
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/^\/v1/, "")
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => {
      headers[key] = value
    })
    const text = request.method === "GET" || request.method === "DELETE" ? "" : await request.text()
    const body = text.length ? (JSON.parse(text) as unknown) : undefined
    const recorded: Recorded = { method: request.method, path, headers, body }
    this.requests.push(recorded)
    this.onRequest?.(recorded)
    if (headers.authorization !== `Bearer ${this.apiKey}`) return this.error(401, "authentication_error", "Invalid API key")
    if (headers["openai-beta"] !== "agents=v1") return this.error(400, "invalid_request", "Missing OpenAI-Beta: agents=v1 header")

    const match = /^\/agents\/sessions(?:\/([^/]+))?(?:\/(events|context|turns))?(?:\/([^/]+))?$/.exec(path)
    if (!match) return this.error(404, "not_found", `No route ${path}`)
    const [, sessionId, sub, turnId] = match

    if (!sessionId) {
      if (request.method !== "POST") return this.error(405, "invalid_request", "Method not allowed")
      return this.create(body as SessionCreate)
    }
    const session = this.sessions.get(sessionId)
    if (!session || session.deleted) return this.error(404, "not_found", `Session ${sessionId} not found`)

    if (sub === undefined) {
      if (request.method === "GET") return Response.json(this.resource(session))
      if (request.method === "DELETE") {
        session.deleted = true
        return Response.json({ id: session.id, object: "agent.session.deleted", deleted: true })
      }
      if (request.method === "POST") {
        const update = body as { metadata?: Record<string, string>; agent?: { reasoning?: { effort?: string | null } } }
        if (update.metadata) session.metadata = { ...session.metadata, ...update.metadata }
        if (update.agent?.reasoning) session.effort = update.agent.reasoning.effort
        return Response.json(this.resource(session))
      }
    }
    if (sub === "context") return Response.json({ object: "agent.session.context", session_id: session.id, input_tokens: session.contextTokens })
    if (sub === "turns" && turnId) {
      const turn = session.turns.get(turnId)
      if (!turn) return this.error(404, "not_found", "turn not found")
      return Response.json({ id: turn.id, session_id: session.id, status: turn.status, usage: turn.usage })
    }
    if (sub === "events" && request.method === "GET") return this.subscribe(session)
    if (sub === "events" && request.method === "POST") {
      const key = headers["idempotency-key"]
      if (key !== undefined) {
        const seen = this.idempotency.get(key)
        if (seen !== undefined) return new Response(null, { status: 202 })
        this.idempotency.set(key, Date.now())
      }
      const events = (body as { events: InputEvent[] }).events
      if (!Array.isArray(events) || events.length === 0 || events.length > 256) return this.error(400, "invalid_request", "events must have 1-256 items")
      queueMicrotask(() => this.apply(session, events))
      return new Response(null, { status: 202 })
    }
    return this.error(404, "not_found", `No route ${request.method} ${path}`)
  }

  private error(status: number, code: string, message: string): Response {
    return Response.json({ error: { type: code, code, message } }, { status })
  }

  private resource(session: Session) {
    return {
      id: session.id,
      object: "agent.session",
      status: session.status,
      required_actions: session.required,
      metadata: session.metadata,
      agent: { ...session.agent, reasoning: { effort: session.effort ?? null } },
    }
  }

  private create(body: SessionCreate): Response {
    if (!body || body.environment?.type !== "none") return this.error(400, "invalid_request", "environment.type must be none")
    if (!body.agent?.model) return this.error(400, "invalid_request", "agent.model required")
    for (const tool of body.agent.tools ?? []) {
      if (!/^[a-zA-Z0-9_-]{1,96}$/.test((tool as FunctionTool).name)) return this.error(400, "invalid_request", `bad tool name ${(tool as FunctionTool).name}`)
    }
    const session: Session = {
      id: this.id("sess"),
      agent: body.agent,
      status: "idle",
      history: [],
      turns: new Map(),
      currentTurn: undefined,
      required: [],
      subscribers: new Set(),
      contextTokens: null,
      metadata: body.metadata ?? {},
      effort: body.agent.reasoning?.effort,
      deleted: false,
    }
    this.sessions.set(session.id, session)
    const input: InputMessage[] = typeof body.input === "string" ? [{ role: "user", content: [{ type: "input_text", text: body.input }] }] : [...body.input]
    for (const message of input) session.history.push({ kind: "message", message })
    const response = this.subscribe(session, true)
    queueMicrotask(() => {
      this.emit(session, { type: "agent.session.created", session: this.resource(session) })
      this.runTurn(session)
    })
    return response
  }

  private subscribe(session: Session, _created = false): Response {
    let push: ((event: Record<string, unknown>) => void) | undefined
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const encoder = new TextEncoder()
        push = (event) => {
          try {
            controller.enqueue(encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`))
          } catch {
            // closed
          }
        }
        session.subscribers.add(push)
        controller.enqueue(encoder.encode(": connected\n\n"))
      },
      cancel: () => {
        if (push) session.subscribers.delete(push)
      },
    })
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  }

  private emit(session: Session, event: Record<string, unknown>): void {
    const payload = { event_id: this.id("evt"), session_id: session.id, ...event }
    for (const push of session.subscribers) push(payload)
  }

  private apply(session: Session, events: InputEvent[]): void {
    let resumeTurn: string | undefined
    let newMessages = 0
    for (const event of events) {
      if (event.type === "agent.session.input.cancel") {
        const turnId = session.currentTurn
        if (turnId) {
          const turn = session.turns.get(turnId)
          if (turn && (turn.status === "waiting" || turn.status === "in_progress")) {
            turn.status = "cancelled"
            session.required = []
            session.status = "idle"
            this.emit(session, { type: "agent.session.turn.cancelled", turn_id: turnId, turn: { id: turnId, session_id: session.id, status: "cancelled", usage: turn.usage } })
            this.emit(session, { type: "agent.session.idle", session: this.resource(session) })
          }
        }
        continue
      }
      if (event.type === "agent.session.input.tool_result") {
        const turn = session.turns.get(event.turn_id)
        if (!turn || !turn.calls.has(event.call_id)) throw new Error(`mock: tool_result for unknown ${event.turn_id}/${event.call_id}`)
        session.history.push({ kind: "tool_result", turn: event.turn_id, call: event.call_id, success: event.success, output: typeof event.output === "string" ? event.output : (event.error ?? null) })
        session.required = session.required.filter((action) => action.call_id !== event.call_id)
        this.emit(session, {
          type: "agent.session.turn.item.added",
          turn_id: event.turn_id,
          item: { id: this.id("item"), type: "function_call_output", turn_id: event.turn_id, call_id: event.call_id, output: event.output ?? null, error: event.error ?? null, status: event.success ? "completed" : "failed" },
        })
        if (session.required.length === 0) resumeTurn = event.turn_id
        continue
      }
      for (const message of event.input) {
        session.history.push({ kind: "message", message })
        newMessages += 1
      }
    }
    if (resumeTurn !== undefined) {
      this.continueTurn(session, resumeTurn)
      return
    }
    if (newMessages > 0) {
      if (session.status === "requires_action") throw new Error("mock: message queued behind a waiting turn (bridge should have cancelled)")
      this.runTurn(session)
    }
  }

  private runTurn(session: Session): void {
    const turnId = this.id("turn")
    session.turns.set(turnId, { id: turnId, status: "in_progress", usage: null, calls: new Map() })
    session.currentTurn = turnId
    session.status = "in_progress"
    this.emit(session, { type: "agent.session.in_progress", session: this.resource(session) })
    this.emit(session, { type: "agent.session.turn.created", turn_id: turnId, turn: { id: turnId, session_id: session.id, status: "queued" } })
    this.emit(session, { type: "agent.session.turn.in_progress", turn_id: turnId, turn: { id: turnId, session_id: session.id, status: "in_progress" } })
    this.continueTurn(session, turnId)
  }

  private continueTurn(session: Session, turnId: string): void {
    const turn = session.turns.get(turnId)
    if (!turn) throw new Error("mock: no turn")
    const reply = this.script.shift()
    if (!reply) throw new Error("mock: script exhausted")
    session.contextTokens = session.history.reduce((n, entry) => n + (entry.kind === "message" ? JSON.stringify(entry.message).length : (entry.output?.length ?? 0)), 0)
    if (reply.fail) {
      turn.status = "failed"
      session.status = "failed"
      this.emit(session, { type: "agent.session.turn.failed", turn_id: turnId, turn: { id: turnId, session_id: session.id, status: "failed", error: reply.fail } })
      this.emit(session, { type: "agent.session.failed", session: { ...this.resource(session), error: reply.fail.message } })
      return
    }
    let index = 0
    if (reply.text !== undefined) {
      const itemId = this.id("msg")
      const base = { turn_id: turnId, output_index: index, item_id: itemId, content_index: 0 }
      this.emit(session, { type: "agent.session.turn.item.added", turn_id: turnId, output_index: index, item: { id: itemId, type: "message", turn_id: turnId, role: "assistant", content: [], status: "in_progress" } })
      this.emit(session, { type: "agent.session.turn.content_part.added", ...base, part: { type: "output_text", text: "" } })
      for (const piece of reply.text.match(/.{1,5}/gs) ?? []) this.emit(session, { type: "agent.session.turn.output_text.delta", ...base, delta: piece })
      this.emit(session, { type: "agent.session.turn.output_text.done", ...base, text: reply.text })
      this.emit(session, { type: "agent.session.turn.content_part.done", ...base, part: { type: "output_text", text: reply.text } })
      this.emit(session, { type: "agent.session.turn.item.done", turn_id: turnId, output_index: index, item: { id: itemId, type: "message", turn_id: turnId, role: "assistant", content: [{ type: "output_text", text: reply.text }], status: "completed" } })
      index += 1
    }
    if (reply.calls && reply.calls.length > 0) {
      const required: Session["required"] = []
      for (const call of reply.calls) {
        const callId = this.id("call")
        const itemId = this.id("fc")
        turn.calls.set(callId, { name: call.name, args: call.args })
        this.emit(session, { type: "agent.session.turn.item.added", turn_id: turnId, output_index: index, item: { id: itemId, type: "function_call", turn_id: turnId, call_id: callId, name: call.name, arguments: {}, status: "in_progress" } })
        this.emit(session, { type: "agent.session.turn.item.done", turn_id: turnId, output_index: index, item: { id: itemId, type: "function_call", turn_id: turnId, call_id: callId, name: call.name, arguments: call.args, status: "completed" } })
        required.push({ type: "function_call", turn_id: turnId, call_id: callId, name: call.name, arguments: call.args })
        index += 1
      }
      turn.status = "waiting"
      session.status = "requires_action"
      session.required = required
      this.emit(session, { type: "agent.session.requires_action", session: this.resource(session) })
      return
    }
    const usage: TokenUsage = { input_tokens: session.contextTokens ?? 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: (reply.text?.length ?? 0) + 7, output_tokens_details: { reasoning_tokens: 7 }, total_tokens: 0 }
    turn.status = "completed"
    turn.usage = usage
    session.status = "idle"
    this.emit(session, { type: "agent.session.turn.completed", turn_id: turnId, turn: { id: turnId, session_id: session.id, status: "completed", usage }, usage })
    this.emit(session, { type: "agent.session.idle", session: this.resource(session) })
  }
}
