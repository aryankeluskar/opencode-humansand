# models.dev entry for humans&

Copy these files into a checkout of `sst/models.dev` at the same paths, then:

1. Publish `opencode-humansand` to npm first; `provider.toml`'s `npm` field is how OpenCode installs the provider.
2. Fill in the `TODO` fields from humans& (release date, knowledge cutoff) and replace `logo.svg` with their official
   mark (the file here is a placeholder glyph and must not be submitted).
3. `bun validate` and `bun run v1:check` in the models.dev checkout.
4. Open the PR.

Sources used for the numbers: the Ampersand API reference and model card at https://ampersand.humansand.ai/docs
(pricing $1 / $0.20 cached / $5.20 per million tokens; 1M context; reasoning effort `high` and `max`; tools frozen
per session; no reasoning text returned; text-only input in this bridge).
