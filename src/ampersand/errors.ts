import { APICallError } from "@ai-sdk/provider"
import type { JsonObject, TurnError, TurnErrorCode } from "./types.js"

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504])

/** Ampersand turn error codes that mean the request cannot succeed by retrying as-is. */
const TERMINAL_TURN_CODES: ReadonlySet<TurnErrorCode> = new Set<TurnErrorCode>([
  "context_length_exceeded",
  "session_budget_exceeded",
  "invalid_request",
  "insufficient_credit",
  "access_denied",
  "access_unavailable",
])

const CONTEXT_OVERFLOW_HINT = "context length exceeded"

export interface HttpFailure {
  readonly url: string
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string
  readonly requestBody?: unknown
}

const parseBody = (body: string): { readonly message?: string; readonly code?: string; readonly type?: string } => {
  try {
    const json = JSON.parse(body) as { error?: { message?: string; code?: string | null; type?: string } }
    if (json && typeof json === "object" && json.error && typeof json.error === "object") {
      return {
        message: typeof json.error.message === "string" ? json.error.message : undefined,
        code: typeof json.error.code === "string" ? json.error.code : undefined,
        type: typeof json.error.type === "string" ? json.error.type : undefined,
      } as { message?: string; code?: string; type?: string }
    }
  } catch {
    // fall through
  }
  return {}
}

/** Map an HTTP failure to an `APICallError` that AI SDK hosts (OpenCode included) can classify and retry. */
export function httpError(failure: HttpFailure): APICallError {
  const parsed = parseBody(failure.body)
  const detail = parsed.message ?? (failure.body.length > 0 ? failure.body.slice(0, 500) : undefined)
  const message = detail
    ? `Ampersand request failed with HTTP ${failure.status}: ${detail}`
    : `Ampersand request failed with HTTP ${failure.status}`
  return new APICallError({
    message,
    url: failure.url,
    requestBodyValues: failure.requestBody ?? null,
    statusCode: failure.status,
    responseHeaders: failure.headers,
    responseBody: failure.body,
    isRetryable: RETRYABLE_STATUS.has(failure.status),
    data: { code: parsed.code ?? null, type: parsed.type ?? null } satisfies JsonObject,
  })
}

/** A turn that ended with `failed`. `context_length_exceeded` is phrased so hosts recognize context overflow. */
export function turnFailure(url: string, sessionId: string, turnId: string, error: TurnError | null | undefined): APICallError {
  const code = error?.code ?? "server_error"
  const base = error?.message ?? "Turn failed"
  const message =
    code === "context_length_exceeded"
      ? `Ampersand turn ${turnId} failed: ${CONTEXT_OVERFLOW_HINT} (${base})`
      : `Ampersand turn ${turnId} failed (${code}): ${base}`
  const statusCode = code === "insufficient_credit" ? 402 : code === "access_denied" ? 403 : undefined
  return new APICallError({
    message,
    url,
    requestBodyValues: { session_id: sessionId, turn_id: turnId },
    ...(statusCode === undefined ? {} : { statusCode }),
    isRetryable: !TERMINAL_TURN_CODES.has(code as TurnErrorCode),
    data: { code, message: base },
  })
}

export function streamFailure(url: string, message: string, code?: string | null): APICallError {
  return new APICallError({
    message: `Ampersand stream error: ${message}`,
    url,
    requestBodyValues: null,
    isRetryable: false,
    data: { code: code ?? null, message },
  })
}

/** Transport-level failure (network, abort, timeout). */
export function transportError(url: string, cause: unknown, phase: string): APICallError {
  const message = cause instanceof Error ? cause.message : String(cause)
  return new APICallError({
    message: `Ampersand ${phase} failed: ${message}`,
    url,
    requestBodyValues: null,
    cause,
    isRetryable: true,
  })
}
