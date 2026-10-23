import { EventSourceParserStream } from "@ai-sdk/provider-utils"
import type { ServerEvent } from "./types.js"

/** `HUMANSAND_TRACE_FILE=/path` appends every raw server event (one JSON line each) for diagnosing API differences. */
const trace = (data: string): void => {
  const file = process.env.HUMANSAND_TRACE_FILE
  if (!file) return
  import("node:fs").then((fs) => fs.appendFileSync(file, `${data}\n`)).catch(() => {})
}

/**
 * Turn an SSE response body into parsed Ampersand events. Empty frames, keep-alive comments, and `[DONE]` are
 * dropped. A frame that is not JSON becomes an `error`-typed event with the raw text so the consumer can fail with
 * context instead of hanging.
 */
export async function* readServerEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<ServerEvent> {
  const reader = body
    .pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>)
    .pipeThrough(new EventSourceParserStream())
    .getReader()
  const onAbort = () => void reader.cancel().catch(() => {})
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      const data = value.data
      if (!data || data === "[DONE]" || data === "null" || data.startsWith(":")) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        yield {
          type: "error",
          event_id: "",
          session_id: "",
          error: { type: "invalid_frame", code: "invalid_frame", message: `Unparseable SSE frame: ${data.slice(0, 200)}` },
        }
        continue
      }
      if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") {
        continue
      }
      trace(data)
      yield parsed as ServerEvent
    }
  } finally {
    signal?.removeEventListener("abort", onAbort)
    reader.releaseLock()
  }
}
