# PR description draft: `sst/models.dev`

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
- `bun validate` and `bun run v1:check` pass locally.

(Fill in before opening: release date and knowledge cutoff confirmed with humans&, official logo.)
