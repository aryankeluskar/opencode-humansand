import { combineHeaders, withoutTrailingSlash, type FetchFunction } from "@ai-sdk/provider-utils"
import { httpError, transportError } from "./errors.js"
import { readServerEvents } from "./sse.js"
import type {
  InputEvent,
  ServerEvent,
  SessionContext,
  SessionCreate,
  SessionResource,
  SessionUpdate,
  TurnResource,
} from "./types.js"

export const DEFAULT_BASE_URL = "https://ampersand.humansand.ai/v1"
export const DEFAULT_MODEL = "ampersand-v0.1"

export interface ClientConfig {
  readonly baseURL?: string | undefined
  readonly apiKey: () => string
  readonly headers?: Record<string, string | undefined> | undefined
  readonly fetch?: FetchFunction | undefined
}

/** An open SSE stream. `events` yields parsed events; `close` aborts the underlying body. */
export interface EventStream {
  readonly url: string
  readonly headers: Record<string, string>
  readonly events: AsyncGenerator<ServerEvent>
  readonly close: () => void
}

export interface Client {
  readonly baseURL: string
  /** `POST /agents/sessions` with `stream: true`. The first turn's events arrive on the returned stream. */
  readonly createSessionStream: (body: SessionCreate, signal?: AbortSignal) => Promise<EventStream>
  /** `GET /agents/sessions/{id}/events`. Resolves once response headers arrived, so later input cannot race it. */
  readonly openEvents: (sessionId: string, signal?: AbortSignal) => Promise<EventStream>
  /** `POST /agents/sessions/{id}/events`. Resolves on 202. */
  readonly postEvents: (
    sessionId: string,
    events: ReadonlyArray<InputEvent>,
    idempotencyKey: string | undefined,
    signal?: AbortSignal,
  ) => Promise<void>
  readonly retrieveSession: (sessionId: string, signal?: AbortSignal) => Promise<SessionResource>
  readonly updateSession: (sessionId: string, body: SessionUpdate, signal?: AbortSignal) => Promise<SessionResource>
  readonly retrieveTurn: (sessionId: string, turnId: string, signal?: AbortSignal) => Promise<TurnResource>
  readonly getContext: (sessionId: string, signal?: AbortSignal) => Promise<SessionContext>
  readonly deleteSession: (sessionId: string, signal?: AbortSignal) => Promise<void>
}

const headerRecord = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

export function createClient(config: ClientConfig): Client {
  const baseURL = withoutTrailingSlash(config.baseURL) ?? DEFAULT_BASE_URL
  const doFetch: FetchFunction = config.fetch ?? globalThis.fetch

  const headers = (extra?: Record<string, string | undefined>) =>
    combineHeaders(
      {
        authorization: `Bearer ${config.apiKey()}`,
        "openai-beta": "agents=v1",
        accept: "application/json",
      },
      config.headers,
      extra,
    )

  const request = async (
    method: "GET" | "POST" | "DELETE",
    path: string,
    init: { body?: unknown; headers?: Record<string, string | undefined>; signal?: AbortSignal | undefined; stream?: boolean },
  ): Promise<Response> => {
    const url = `${baseURL}${path}`
    const merged = headers({
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.stream ? { accept: "text/event-stream" } : {}),
      ...init.headers,
    })
    const clean: Record<string, string> = {}
    for (const [key, value] of Object.entries(merged)) if (value !== undefined) clean[key] = value
    let response: Response
    try {
      const requestInit: RequestInit = { method, headers: clean }
      if (init.body !== undefined) requestInit.body = JSON.stringify(init.body)
      if (init.signal) requestInit.signal = init.signal
      response = await doFetch(url, requestInit)
    } catch (cause) {
      throw transportError(url, cause, `${method} ${path}`)
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "")
      throw httpError({ url, status: response.status, headers: headerRecord(response.headers), body, requestBody: init.body })
    }
    return response
  }

  const toEventStream = (url: string, response: Response, signal: AbortSignal | undefined): EventStream => {
    if (!response.body) throw transportError(url, new Error("Empty SSE response body"), "stream")
    const controller = new AbortController()
    const onOuter = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", onOuter, { once: true })
    const events = readServerEvents(response.body, controller.signal)
    return {
      url,
      headers: headerRecord(response.headers),
      events,
      close: () => {
        signal?.removeEventListener("abort", onOuter)
        controller.abort()
      },
    }
  }

  const json = async <T>(response: Response): Promise<T> => (await response.json()) as T

  return {
    baseURL,
    createSessionStream: async (body, signal) => {
      const path = "/agents/sessions"
      const response = await request("POST", path, { body: { ...body, stream: true }, signal, stream: true })
      return toEventStream(`${baseURL}${path}`, response, signal)
    },
    openEvents: async (sessionId, signal) => {
      const path = `/agents/sessions/${encodeURIComponent(sessionId)}/events`
      const response = await request("GET", path, { signal, stream: true })
      return toEventStream(`${baseURL}${path}`, response, signal)
    },
    postEvents: async (sessionId, events, idempotencyKey, signal) => {
      await request("POST", `/agents/sessions/${encodeURIComponent(sessionId)}/events`, {
        body: { events },
        headers: idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey },
        signal,
      })
    },
    retrieveSession: async (sessionId, signal) =>
      json<SessionResource>(await request("GET", `/agents/sessions/${encodeURIComponent(sessionId)}`, { signal })),
    updateSession: async (sessionId, body, signal) =>
      json<SessionResource>(await request("POST", `/agents/sessions/${encodeURIComponent(sessionId)}`, { body, signal })),
    retrieveTurn: async (sessionId, turnId, signal) =>
      json<TurnResource>(
        await request("GET", `/agents/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`, {
          signal,
        }),
      ),
    getContext: async (sessionId, signal) =>
      json<SessionContext>(await request("GET", `/agents/sessions/${encodeURIComponent(sessionId)}/context`, { signal })),
    deleteSession: async (sessionId, signal) => {
      await request("DELETE", `/agents/sessions/${encodeURIComponent(sessionId)}`, { signal })
    },
  }
}
