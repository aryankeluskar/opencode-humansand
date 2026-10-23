# Upstream plan

Two contributions make the bridge zero-config for everyone.

## 1. models.dev provider entry (`sst/models.dev`)

Files are prepared under `contrib/models.dev/` in this repository:

- `providers/humansand/provider.toml` — `npm = "opencode-humansand"`, `opencodeai = "none"` until (2) lands.
- `providers/humansand/models/ampersand-v0.1.toml` — host overrides (reasoning controls, pricing, status).
- `models/humansand/ampersand-v0.1.toml` — the lab file (modalities, capabilities, limits).
- `providers/humansand/logo.svg` — must be humans&'s official mark; the placeholder is not it.

Before submitting: publish `opencode-humansand` to npm (models.dev's `npm` field makes OpenCode install it), fill in
`release_date` and `knowledge` from humans&, replace the logo, run `bun validate` in the models.dev checkout.

With that entry OpenCode installs the package on first use and `humansand/ampersand-v0.1` works with only
`HUMANSAND_API_KEY` set. The plugin stays useful for local titles and session metadata.

## 2. Native protocol in OpenCode (`anomalyco/opencode`)

`packages/ai/src/providers/humansand/` implementing the Agents API as a first-class `@opencode/ai` route:

- **Protocol**: `body.from(LLMRequest)` builds either a session-create body or an events batch, deciding
  CREATE/CONTINUE from the same anchor this package stores in `native`. `stream.step` translates the SSE event
  stream exactly as `src/stream/translate.ts` does here.
- **Transport**: a custom transport (like the websocket transports) that performs the two-request CONTINUE
  sequence (open events stream, then POST events) and the follow-up `GET /context`.
- **Compaction**: `compact` operations can map to Ampersand's server-side compaction, and `contextTokens` comes
  straight from `GET /context`, so the context meter is exact instead of estimated.
- **Errors**: `context_length_exceeded`, `insufficient_credit` and friends map to OpenCode's typed `AIError`
  classes, which gives the retry/compaction policy the right signals without string matching.
- **Catalog**: `providers/humansand/provider.toml` gets `opencodeai = "@opencode/ai/providers/humansand"`.

The lowering, anchor format, delta computation, truncation and the mock server from this package port over
directly; the test suite becomes the protocol's conformance tests.
