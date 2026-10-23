# PR description: `anomalyco/models.dev` (base `dev`, head `aryankeluskar:humansand-ampersand`)

**Title:** Add humans& (Ampersand v0.1)

**Body:**

Adds the `humansand` provider and its `ampersand-v0.1` model.

humans& serves Ampersand through an Agents API (server-held sessions, input events, tool results) rather than
chat completions, so there is no OpenAI-compatible endpoint to point `@ai-sdk/openai-compatible` at. The `npm`
field is `opencode-humansand`, an AI SDK v6 provider that bridges the Agents API to stateless calls
(https://github.com/aryankeluskar/opencode-humansand). `opencodeai = "none"` until a native `@opencode/ai`
provider lands.

Facts and sources:

- Pricing $1 / $0.20 cached / $5.20 per million tokens, 1M context, reasoning effort `high` (default) and `max`,
  tools frozen per session, no reasoning text returned: https://ampersand.humansand.ai/docs
- Lab file `models/humansand/ampersand-v0.1.toml`; provider overrides in
  `providers/humansand/models/ampersand-v0.1.toml`.
- `bun validate` passes locally; `bun run v1:check` reports the provider as an addition only (no changes to
  existing v1 output). Not `v2_only`: OpenCode reads the v1 feed and maps `npm` to an `aisdk:` package.
- Logo is the ampersand glyph from humans&'s own wordmark (humansand.ai/assets/site-wordmark.svg), `currentColor`.

(Before opening: `opencode-humansand` must be on npm, otherwise OpenCode cannot install the package the entry
names. Knowledge cutoff is not published and is omitted.)
