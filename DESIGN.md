# Design: opencode-humansand

Bridge between humans& **Ampersand** (`ampersand-v0.1`, OpenAI Agents-API shaped, server-held sessions)
and **OpenCode V2** (stateless per-step model calls). One npm package, two entrypoints:

| Entrypoint | What it is | Loaded by |
| --- | --- | --- |
| `opencode-humansand` | AI SDK v3-spec provider (`createHumansand`) | OpenCode's AI SDK bridge (`aisdk:` packages, `DynamicProviderPlugin` picks the first `create*` export), and any `ai@6` app |
| `opencode-humansand/server` | OpenCode plugin | `plugins: ["opencode-humansand"]` (host resolves `<name>/server` first) |

## Why an AI SDK provider and not a native `@opencode/ai` protocol (yet)

OpenCode V2's native runtime (`@opencode/ai`) is the better home long-term (precise `contextTokens`, compaction
operations, error classification). But a third-party native package would import its own copy of `@opencode/ai`;
the compiled OpenCode binary only shares `effect` and `@opencode/plugin` with external code (`ensurePluginRuntime`),
so `instanceof` checks on `AIError`/`LanguageModel` would silently degrade. The AI SDK bridge is the path OpenCode
designs for third parties (OpenRouter, GitLab, SAP all use it), auto-installs from npm, and the same package works
in every AI SDK app. The native protocol is phase 2, written inside `anomalyco/opencode` as a PR.

## Session continuity (the hard part)

Ampersand holds history server-side. OpenCode resends the full transcript each step. The provider must decide,
per call, whether to **CONTINUE** an Ampersand session (send only the delta) or **CREATE** one (full replay).

### Anchor

State rides on assistant parts as `providerMetadata.humansand` (OpenCode persists it as `native` and replays it on the
next request as `providerOptions.humansand`, but only for the same provider+model and only on error-free messages):

```jsonc
{ "v": 1, "session": "sess_…", "agent": "<sha256 of model+instructions+tools+effort+ampersand opts>",
  "turn": "turn_…", "status": "waiting" | "completed", "call": "call_…" /* tool-call parts only */ }
```

Every step emits a zero-length reasoning block carrying the anchor (OpenCode keeps empty reasoning parts when they carry
provider metadata; text parts are dropped when empty). This is what makes **silent completions** (no text, no tools)
resumable. Text and tool-call parts carry it too.

Reading: find the last assistant message in the prompt, scan its parts from the end for `providerOptions.humansand`
with `v === 1`. Everything after that message is the delta.

### Decision

```
anchor absent                         → CREATE (first step of a session, fork, after OpenCode compaction, model switch)
anchor.agent !== hash(current agent)  → CREATE (agent switch, MCP/skill/Code Mode change, effort change is NOT a
                                        reason: effort is updatable in place)
anchor present, hash equal            → CONTINUE
```

CONTINUE payload = `agent.session.input.tool_result` for each tool message in the delta (turn_id from the matching
tool-call part's metadata, call_id = toolCallId) followed by one `agent.session.input.message` with all new user
messages. If the anchor turn is `waiting` but the delta has no tool results, the turn is cancelled first.

CREATE payload = `POST /agents/sessions` with the whole prompt lowered to Ampersand `role: user` messages:
user text as-is (`sender` from options, default `user`); assistant text → `sender: "assistant"`; assistant tool calls
→ `sender: "assistant"` text `Called <name> with <json>`; tool results → `sender: "tool"`. Replay is tagged
`metadata.source = "opencode-humansand/replay"` so Ampersand's `(source,id)` dedupe can never 409 against live
messages. Oversized tool outputs are truncated to fit the 4 MiB request cap. When an old anchor exists, the old
Ampersand session is deleted after the new one is created (keeps the 10k-session cap and billing clean).

### Wire sequence (CONTINUE)

1. `GET /agents/sessions/{id}/events` (SSE). Wait for response headers so no event is missed.
2. `POST /agents/sessions/{id}/events` with `Idempotency-Key = sha256(session, turn, call_ids, message ids)`.
3. Read SSE until one of: `agent.session.requires_action` listing call_ids we did not just answer → finish
   `tool-calls`; `agent.session.turn.completed` → finish `stop`; `turn.failed` / `turn.cancelled` /
   `agent.session.failed` → error.
4. `GET /agents/sessions/{id}/context` → `inputTokens.total` for the step (see Usage).

CREATE uses `stream: true` on the create request and reads the same way.

## Stream translation

| Ampersand SSE | AI SDK stream part |
| --- | --- |
| `turn.item.added` function_call | `tool-input-start` (+ one `tool-input-delta` with the full JSON) |
| `turn.item.done` function_call | `tool-input-end`, `tool-call{providerMetadata.humansand:{session,turn,call}}` |
| `turn.output_text.delta` | `text-delta` (id = `item_id:content_index`, `text-start` on first) |
| `turn.output_text.done` | `text-end` |
| `turn.item.done` assistant message | closes any open text for that item |
| `session.requires_action` | emit any listed call not yet emitted, then `finish{tool-calls}` |
| `turn.completed` | `finish{stop}` (silent completion = no content before it) |
| `turn.failed` | `error` with Ampersand `code` → `context_length_exceeded` is surfaced as a context-overflow message |
| `error` SSE event | `error` |

## Usage

Ampersand reports usage per **turn**, only at completion, cumulative across model calls. OpenCode wants usage per
step. Policy: every step reports `inputTokens.total = inputTokens.noCache = GET /context` (the last model call's input,
which is also what OpenCode's context meter should show, and which survives Ampersand's server-side compaction);
`outputTokens` is reported on the completing step from the turn's `output_tokens` (reasoning tokens included, as
Ampersand bills them). `usage.raw` carries the untouched Ampersand usage and context reading. Cost in OpenCode is
therefore a slight over-estimate (cache discount ignored).

## Settings (`providers.humansand.settings` / `createHumansand({...})`)

| Key | Default | Meaning |
| --- | --- | --- |
| `apiKey` | `HUMANSAND_API_KEY`, then `AMPERSAND_API_KEY` | Bearer token |
| `baseURL` | `https://ampersand.humansand.ai/v1` | |
| `headers` | | extra headers |
| `compaction` | `"auto"` | Ampersand server-side compaction (`auto` or `disabled`). OpenCode still compacts on its own; when it does, the anchor disappears and a new session is created from the summary. |
| `allowSilentCompletion` | `true` | set `false` when a `pass` tool is declared (the plugin does this) |
| `sender`, `channel` | `"user"`, `"opencode"` | metadata stamped on user messages |

Per-call `providerOptions.humansand`: `reasoningEffort` (`high`/`max`; lower efforts map to `high`, `xhigh` to
`max`), `sender`, `channel`, `sessionKey` (non-OpenCode callers that want an explicit key), `compaction`,
`allowSilentCompletion`, `metadata` (merged into message metadata).

## Guard rails (documented in README)

- **Rate limits**: Normal tier = 10 work requests/min. Every step is one. A tool-heavy loop hits this in a minute.
  429 is surfaced retryable with `Retry-After` so OpenCode backs off; the README tells people to ask for High tier.
- **Tool schema budget**: 32 KiB/tool, 128 KiB total. The provider fails fast with a clear error listing the
  offenders instead of letting Ampersand 400. Code Mode (`execute`/`search`) is the recommended fix.
- **Prompt injection**: Ampersand's own model card reports higher susceptibility than frontier models. The README
  recommends `ask` permissions for `bash`/`edit` when it orchestrates.
- No reasoning text is returned (tokens only). No images when moderation is on. Effort is `high`/`max` only.

## Plugin (`opencode-humansand/server`)

- Registers provider `humansand` (package `aisdk:opencode-humansand`, model `ampersand-v0.1` with pricing and limits)
  so `plugins: ["opencode-humansand"]` is the only config needed besides the key.
- Supplies the SDK in-process through `ctx.aisdk.hook("sdk")` so the provider and plugin share one module instance.
- Adds a `pass` tool (no-op, "yield without a visible message") and sets `allowSilentCompletion=false` for the
  `humansand` provider via a `context` hook, which also stamps `sender`/`channel` and the OpenCode session id.
- Ships `docs/chief-of-staff.md`: an agent definition that pairs Ampersand with `task` (subagents), Code Mode, and
  Supermemory MCP, plus a permission set.

## Out of scope for v1

Native `@opencode/ai` protocol (phase 2 upstream PR), webhooks, Ampersand saved agents (`agent_id`), image input,
compaction triggers, V4-spec export (cheap follow-up; the shapes are identical except `interrupted`).
