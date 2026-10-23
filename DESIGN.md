# Design: opencode-humansand

Bridge between humans& **Ampersand** (`ampersand-v0.1`, OpenAI Agents-API shaped, server-held sessions)
and **OpenCode V2** (stateless per-step model calls). One npm package, two entrypoints:

| Entrypoint | What it is | Loaded by |
| --- | --- | --- |
| `opencode-humansand` | AI SDK v3-spec provider (`createHumansand`) | OpenCode's AI SDK bridge (`aisdk:` packages; the built-in dynamic loader imports the first `create*` export), and any `ai@6` app |
| `opencode-humansand/server` | OpenCode plugin | `plugins: ["opencode-humansand"]` (host resolves `<name>/server` first; a directory plugin resolves `<dir>/server.ts`, hence the root shim) |

## Why an AI SDK provider and not a native `@opencode/ai` protocol (yet)

OpenCode V2's native runtime (`@opencode/ai`) is the better home long-term (precise `contextTokens`, compaction
operations, error classification). But a third-party native package would import its own copy of `@opencode/ai`;
the compiled OpenCode binary only shares `effect` and `@opencode/plugin` with external code (`ensurePluginRuntime`),
so `instanceof` checks on `AIError`/`LanguageModel` would silently degrade. The AI SDK bridge is the path OpenCode
designs for third parties (OpenRouter, GitLab, SAP all use it), auto-installs from npm, and the same package works
in every AI SDK app. The native protocol is phase 2, written inside `anomalyco/opencode` as a PR (see
`docs/upstream.md`).

## Session continuity (the hard part)

Ampersand holds history server-side. OpenCode resends the full transcript each step. The provider must decide,
per call, whether to **CONTINUE** an Ampersand session (send only the delta) or **CREATE** one (full replay).

### Anchor

State rides on assistant parts as `providerMetadata.humansand` (OpenCode persists it as the part's `native` data and
replays it on the next request as `providerOptions.humansand`, but only for the same provider+model and only on
error-free messages):

```jsonc
{ "v": 1, "session": "sess_…", "agent": "<sha256 of model+instructions+tools+ampersand opts>",
  "turn": "turn_…", "status": "waiting" | "completed", "effort": "high" /* when pinned */,
  "call": "call_…" /* tool-call parts only */ }
```

Carriers, in order of preference:

- `text-end` of every text part carries `status: "completed"` (a text part that ends the step means the turn
  completed; if a tool call follows, its own anchor comes later in the message and wins).
- `tool-call` parts carry `status: "waiting"` plus their `call_id`.
- A zero-length reasoning block is emitted **only** when neither happened (silent completion). OpenCode keeps empty
  reasoning parts when they carry provider metadata, and drops empty text parts.

Reading: find the last assistant message in the prompt, scan its parts from the end for `providerOptions.humansand`
with `v === 1`. Everything after that message is the delta. Tool call ids map to turn ids through the tool-call
parts' anchors (call ids may repeat across turns; the most recent message wins).

### Decision

```
anchor absent                         → CREATE (first step of a session, fork, after OpenCode compaction, model switch)
anchor.agent !== hash(current agent)  → CREATE (agent switch, MCP/skill/Code Mode change). Effort is NOT in the hash:
                                        it is updatable in place with POST /agents/sessions/{id}
anchor present, hash equal            → CONTINUE
```

CONTINUE payload = `agent.session.input.tool_result` for each tool message in the delta (turn_id from the matching
tool-call part's anchor, call_id = toolCallId, `success` from the result type, or from OpenCode's
`{"error":{…},"content":[]}` text shape) followed by one `agent.session.input.message` with all new user messages.
If the anchor turn is `waiting` but the delta has no tool results, the turn is cancelled first. A delta with nothing
in it (host retry with no new input) sends a system `Continue.` nudge rather than posting zero events (400).

CREATE payload = `POST /agents/sessions` with the whole prompt lowered to Ampersand `role: user` messages:
leading system messages become `agent.instructions`; user text as-is (`sender` from options, default `user`;
`<system-update>` wrappers get `sender: "system"`); assistant text → `sender: "assistant"`; assistant tool calls →
`sender: "assistant"` text `Called <name> with <json>`; tool results → `sender: "tool"`. Replay is tagged
`metadata.source = "opencode-humansand/replay"` so Ampersand's `(source,id)` dedupe can never 409 against live
messages. Oversized tool outputs are truncated (200 KiB each), then the oldest messages dropped with a marker, to fit
the 4 MiB request cap. When an old anchor exists, the old Ampersand session is deleted after the new one is created
(keeps the 10k-session cap and billing clean).

### Idempotency and retries

Ampersand treats a repeated `Idempotency-Key` with the same body as "no new work", and a repeated `(source, id)`
message with the same content as a duplicate to drop. Both would leave a host retry (after a dropped stream) waiting
for a turn that never starts. Message ids and the idempotency key therefore include a per-attempt nonce: one POST per
attempt is still protected, and a retry is new work. The cost is a possible duplicate user message server-side.

### Wire sequence (CONTINUE)

1. (`effort` changed) `POST /agents/sessions/{id}` with `agent.reasoning.effort`.
2. `GET /agents/sessions/{id}/events` (SSE). Wait for response headers so no event is missed.
2b. (anchor turn `waiting`, no tool results in the delta) `POST` a lone `agent.session.input.cancel`, then read the
   stream until that turn's terminal event (capped at 30 s). The live API answers 409 to any input batched with,
   or posted during, a cancel.
3. `POST /agents/sessions/{id}/events` with `Idempotency-Key`.
4. Read SSE until one of: `agent.session.requires_action` listing call_ids we did not just answer → finish
   `tool-calls`; `agent.session.turn.completed` → finish `stop`; `turn.failed` / `agent.session.failed` / `error`
   → error part; `turn.cancelled` → finish `other`. Events for a turn we cancelled in step 3 are ignored.
5. `GET /agents/sessions/{id}/context` → `inputTokens.total` for the step (see Usage).

A 404/410 on steps 1–3 means the session is gone: fall back to CREATE with full replay. CREATE uses `stream: true`
on the create request and reads the same way; the session id arrives on `agent.session.created`.

Aborts (stream cancel or the call's abort signal) close the SSE read and post `agent.session.input.cancel` unless the
step had already finished.

## Stream translation

| Ampersand SSE | AI SDK stream part |
| --- | --- |
| `turn.item.added` function_call | `tool-input-start` (the live API sends complete `arguments` here and no `item.done` before `requires_action`) |
| `turn.item.done` function_call | `tool-input-delta` (full JSON), `tool-input-end`, `tool-call{providerMetadata.humansand}`; skipped for calls this step answered (the API replays `item.done` once the result lands) |
| `turn.output_text.delta` | `text-delta` (id = `item_id:content_index`, `text-start` on first) |
| `turn.output_text.done` / `content_part.done` | `text-end{providerMetadata.humansand}` (whole text emitted if no deltas arrived) |
| `turn.item.done` assistant message | closes any open text for that item |
| `session.requires_action` | emit any listed call not yet emitted, then `finish{tool-calls}` |
| `turn.completed` | `finish{stop}` (silent completion = reasoning anchor block + finish) |
| `turn.failed` | `error` with `APICallError`; `context_length_exceeded` is phrased as a context-overflow message and is non-retryable, as are `insufficient_credit`, `invalid_request`, `access_denied`, `session_budget_exceeded` |
| `error` SSE event, `session.failed` | `error` |
| stream ends without a terminal event | `error` (retryable) unless we closed it |

## Usage

Ampersand reports usage per **turn**, only at completion, cumulative across model calls. OpenCode wants usage per
step. Policy: every step reports `inputTokens.total = inputTokens.noCache = GET /context` (the last model call's input,
which is also what OpenCode's context meter should show, and which survives Ampersand's server-side compaction);
`outputTokens` is reported on the completing step from the turn's `output_tokens` (reasoning tokens included, as
Ampersand bills them). `usage.raw` carries the untouched Ampersand usage and context reading. Cost in OpenCode is
therefore a slight over-estimate (cache discount ignored). `contextUsage: false` skips the extra request.

## Settings (`providers.humansand.settings` / `createHumansand({...})`)

| Key | Default | Meaning |
| --- | --- | --- |
| `apiKey` | `HUMANSAND_API_KEY`, then `AMPERSAND_API_KEY` | Bearer token |
| `baseURL` | `https://ampersand.humansand.ai/v1` | |
| `headers` | | extra headers |
| `serverCompaction` | `"auto"` | Ampersand server-side compaction (`auto` or `disabled`). Named to avoid OpenCode's own `compaction` provider setting. OpenCode still compacts on its own; when it does, the anchor disappears and a new session is created from the summary. |
| `allowSilentCompletion` | `true` | whether a turn may end with no text and no tool call |
| `sender`, `channel` | `"user"`, `"opencode"` | metadata stamped on user messages |
| `contextUsage` | `true` | fetch `GET /context` after every step |
| `metadataKey` | `"humansand"` | anchor key; must equal OpenCode's provider option key (the provider id) |

Per-call `providerOptions.humansand`: `reasoningEffort` (`high`/`max`; lower efforts map to `high`, `xhigh` to
`max`), `sender`, `channel`, `serverCompaction`, `allowSilentCompletion`, `metadata` (merged into message
metadata), `sessionMetadata` (string map on the Ampersand session). OpenCode projects unknown provider settings into
provider options too, so the plugin's settings reach both paths.

Unsupported call options produce `warnings` (`temperature`, `topP`, `topK`, penalties, `seed`, `stopSequences`,
non-`auto` `toolChoice`, JSON `responseFormat`, provider-defined tools, file input). `maxOutputTokens` is ignored
silently because OpenCode sends it on every primary request.

## Guard rails (documented in README)

- **Rate limits**: Normal tier = 10 work requests/min. Every step is one. A tool-heavy loop hits this in a minute.
  429 is surfaced retryable with `Retry-After` so OpenCode backs off; the README tells people to ask for High tier.
- **Tool schema budget**: 32 KiB/tool, 128 KiB total, names `^[a-zA-Z0-9_-]{1,96}$`. The provider fails fast with
  a clear error listing the offenders instead of letting Ampersand 400. Code Mode is the recommended fix.
- **Prompt injection**: Ampersand's own model card reports higher susceptibility than frontier models. The README
  recommends `ask` permissions for `shell`/`edit` when it orchestrates.
- No reasoning text is returned (tokens only). No images. Effort is `high`/`max` only.
- `HUMANSAND_DEBUG_FILE` dumps the prompt shape and plan per step (no message text).

## Plugin (`opencode-humansand/server`)

- Registers provider `humansand` (`activation: "auto"`, model `ampersand-v0.1` with pricing and limits) so
  `plugins: ["opencode-humansand"]` is the only config needed besides the key. If models.dev or the user's config
  already defines the provider, only the package is adjusted (unless the user pinned one).
- Sets the provider package to `aisdk:file://<this package>/index.js`: OpenCode's built-in dynamic loader (which runs
  before any plugin hook and dies on an npm miss) imports the code already on disk instead of installing a second
  copy. An `aisdk.hook("sdk")` cannot take priority over the built-in loader, which is why the plugin does not use
  one.
- `session.hook("title")` derives titles locally from the first user message (`titles: "model"` opts out), because
  a title request would otherwise create and strand one Ampersand session per OpenCode session.
- `session.hook("context")` stamps `sessionMetadata.opencode_session` / `opencode_agent`; `sender`, `channel`,
  `serverCompaction`, `allowSilentCompletion` from plugin options become provider settings.
- No `pass` tool. With `allowSilentCompletion: false` a yield tool would return a tool result the model must answer
  again, which loops; silent completions are the right primitive and are rendered as an empty assistant turn.
- Ships `docs/chief-of-staff.md`: an agent definition that pairs Ampersand with subagents, Code Mode and a notes
  MCP server, plus a permission set.

## Out of scope for v1

Native `@opencode/ai` protocol (phase 2 upstream PR), webhooks, Ampersand saved agents (`agent_id`), image input,
compaction triggers, recovery of a finished turn's output after a dropped stream (`GET /items` makes it possible),
V4-spec export (cheap follow-up; the shapes are identical except `interrupted`).
