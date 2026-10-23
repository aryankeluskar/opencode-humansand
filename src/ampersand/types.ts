/**
 * Subset of the Ampersand Agents API (https://ampersand.humansand.ai/docs/API_REFERENCE.html) used by the bridge.
 * Field names mirror the wire format.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export interface InputText {
  readonly type: "input_text"
  readonly text: string
}

export interface InputImage {
  readonly type: "input_image"
  readonly image_url: string
}

export interface OutputText {
  readonly type: "output_text"
  readonly text: string
}

/** Reserved keys are typed; anything else is custom JSON (whole object ≤ 8 KiB). */
export interface EventMetadata {
  readonly id?: string
  readonly source?: string
  readonly channel?: string
  readonly sender?: string
  readonly timestamp?: number
  readonly [key: string]: JsonValue | undefined
}

export interface InputMessage {
  readonly role: "user"
  readonly content: ReadonlyArray<InputText | InputImage>
  readonly type?: "message"
  readonly metadata?: EventMetadata
}

export interface FunctionTool {
  readonly type: "function"
  readonly name: string
  readonly description?: string
  readonly parameters: JsonObject
}

export type ReasoningEffort = "high" | "max"

export interface AmpersandOptions {
  readonly compaction?: "auto" | "disabled"
  readonly allow_silent_completion?: boolean
}

export interface AgentOverrides {
  readonly model: string
  readonly instructions?: string | null
  readonly tools?: ReadonlyArray<FunctionTool>
  readonly reasoning?: { readonly effort?: ReasoningEffort | null }
  readonly ampersand?: AmpersandOptions
}

export interface SessionCreate {
  readonly environment: { readonly type: "none" }
  readonly agent: AgentOverrides
  readonly input: string | ReadonlyArray<InputMessage>
  readonly metadata?: Readonly<Record<string, string>>
  readonly stream?: boolean
}

export interface MessageInputEvent {
  readonly type: "agent.session.input.message"
  readonly input: ReadonlyArray<InputMessage>
}

export interface ToolResultInputEvent {
  readonly type: "agent.session.input.tool_result"
  readonly turn_id: string
  readonly call_id: string
  readonly success: boolean
  readonly output?: string | ReadonlyArray<InputText | InputImage> | null
  readonly error?: string | null
  readonly metadata?: EventMetadata
}

export interface CancelInputEvent {
  readonly type: "agent.session.input.cancel"
}

export type InputEvent = MessageInputEvent | ToolResultInputEvent | CancelInputEvent

export interface SessionUpdate {
  readonly metadata?: Readonly<Record<string, string>>
  readonly agent?: { readonly reasoning: { readonly effort?: ReasoningEffort | null } }
}

export interface TokenUsage {
  readonly input_tokens: number
  readonly input_tokens_details?: { readonly cached_tokens?: number }
  readonly output_tokens: number
  readonly output_tokens_details?: { readonly reasoning_tokens?: number }
  readonly total_tokens: number
}

export interface FunctionRequiredAction {
  readonly type: "function_call"
  readonly turn_id: string
  readonly call_id: string
  readonly name: string
  readonly arguments: JsonObject
}

export type SessionStatus = "idle" | "in_progress" | "requires_action" | "failed"

export interface SessionResource {
  readonly id: string
  readonly object?: "agent.session"
  readonly status: SessionStatus
  readonly error?: string | null
  readonly required_actions?: ReadonlyArray<FunctionRequiredAction>
  readonly usage?: TokenUsage | null
  readonly metadata?: Readonly<Record<string, string>>
  readonly created_at?: number
  readonly last_active_at?: number
}

export type TurnStatus = "queued" | "in_progress" | "waiting" | "completed" | "failed" | "cancelled"

export type TurnErrorCode =
  | "server_error"
  | "context_length_exceeded"
  | "session_budget_exceeded"
  | "invalid_request"
  | "insufficient_credit"
  | "access_denied"
  | "billing_request_in_progress"
  | "access_unavailable"

export interface TurnError {
  readonly code: TurnErrorCode | (string & {})
  readonly message: string
}

export interface TurnResource {
  readonly id: string
  readonly session_id: string
  readonly status: TurnStatus
  readonly error?: TurnError | null
  readonly usage?: TokenUsage | null
  readonly created_at?: number
  readonly started_at?: number | null
  readonly completed_at?: number | null
}

export interface MessageItem {
  readonly id: string
  readonly type: "message"
  readonly turn_id: string
  readonly role: "user" | "assistant"
  readonly content: ReadonlyArray<InputText | InputImage | OutputText>
  readonly phase?: "commentary" | "final_answer" | null
  readonly status?: "in_progress" | "completed" | "incomplete"
  readonly metadata?: EventMetadata | null
}

export interface FunctionCallItem {
  readonly id: string
  readonly type: "function_call"
  readonly turn_id: string
  readonly call_id: string
  readonly name: string
  readonly arguments: JsonObject
  readonly status?: "in_progress" | "completed" | "failed" | "incomplete"
}

export interface FunctionResultItem {
  readonly id: string
  readonly type: "function_call_output"
  readonly turn_id: string
  readonly call_id: string
  readonly output?: string | ReadonlyArray<InputText | InputImage> | null
  readonly error?: string | null
  readonly status: "completed" | "failed"
}

export type Item = MessageItem | FunctionCallItem | FunctionResultItem

export interface SessionError {
  readonly type?: string
  readonly code?: string | null
  readonly message: string
  readonly param?: string | null
}

export interface SessionContext {
  readonly object?: "agent.session.context"
  readonly session_id: string
  readonly input_tokens: number | null
}

export type SessionEventType =
  | "agent.session.created"
  | "agent.session.in_progress"
  | "agent.session.requires_action"
  | "agent.session.idle"
  | "agent.session.failed"

export type TurnEventType =
  | "agent.session.turn.created"
  | "agent.session.turn.in_progress"
  | "agent.session.turn.completed"
  | "agent.session.turn.failed"
  | "agent.session.turn.cancelled"

export interface SessionEvent {
  readonly type: SessionEventType
  readonly event_id: string
  readonly session: SessionResource
}

export interface TurnEvent {
  readonly type: TurnEventType
  readonly event_id: string
  readonly session_id: string
  readonly turn_id: string
  readonly turn: TurnResource
  readonly usage?: TokenUsage | null
}

export interface ItemAddedEvent {
  readonly type: "agent.session.turn.item.added"
  readonly event_id: string
  readonly session_id: string
  readonly turn_id: string
  readonly output_index?: number | null
  readonly item: Item
}

export interface ItemDoneEvent {
  readonly type: "agent.session.turn.item.done"
  readonly event_id: string
  readonly session_id: string
  readonly turn_id: string
  readonly output_index: number
  readonly item: MessageItem | FunctionCallItem
}

export interface ContentPartEvent {
  readonly type: "agent.session.turn.content_part.added" | "agent.session.turn.content_part.done"
  readonly event_id: string
  readonly session_id: string
  readonly turn_id: string
  readonly output_index: number
  readonly item_id: string
  readonly content_index: number
  readonly part: OutputText
}

export interface OutputTextDeltaEvent {
  readonly type: "agent.session.turn.output_text.delta"
  readonly event_id: string
  readonly session_id: string
  readonly turn_id: string
  readonly output_index: number
  readonly item_id: string
  readonly content_index: number
  readonly delta: string
}

export interface OutputTextDoneEvent {
  readonly type: "agent.session.turn.output_text.done"
  readonly event_id: string
  readonly session_id: string
  readonly turn_id: string
  readonly output_index: number
  readonly item_id: string
  readonly content_index: number
  readonly text: string
}

export interface ErrorEvent {
  readonly type: "error"
  readonly event_id: string
  readonly session_id: string
  readonly error: SessionError
}

/** Events the bridge recognizes. Unknown event types still arrive at runtime and fall through `default` branches. */
export type ServerEvent =
  | SessionEvent
  | TurnEvent
  | ItemAddedEvent
  | ItemDoneEvent
  | ContentPartEvent
  | OutputTextDeltaEvent
  | OutputTextDoneEvent
  | ErrorEvent

export interface UnknownEvent {
  readonly type: string
  readonly [key: string]: unknown
}

export const SESSION_EVENT_TYPES: ReadonlySet<string> = new Set<SessionEventType>([
  "agent.session.created",
  "agent.session.in_progress",
  "agent.session.requires_action",
  "agent.session.idle",
  "agent.session.failed",
])

export const TURN_EVENT_TYPES: ReadonlySet<string> = new Set<TurnEventType>([
  "agent.session.turn.created",
  "agent.session.turn.in_progress",
  "agent.session.turn.completed",
  "agent.session.turn.failed",
  "agent.session.turn.cancelled",
])

export const isSessionEvent = (event: ServerEvent): event is SessionEvent => SESSION_EVENT_TYPES.has(event.type)
export const isTurnEvent = (event: ServerEvent): event is TurnEvent => TURN_EVENT_TYPES.has(event.type)
