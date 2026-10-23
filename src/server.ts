/**
 * OpenCode plugin entrypoint (`opencode-humansand/server`).
 *
 * - Registers the `humansand` provider with `ampersand-v0.1` (pricing, limits, capabilities) so that
 *   `plugins: ["opencode-humansand"]` plus an API key is the whole setup.
 * - Points the provider at this package's own AI SDK entry file (`aisdk:file://…/index.js`), so OpenCode's AI SDK
 *   bridge imports the code that is already on disk instead of installing a second copy from npm.
 * - Stamps every request with OpenCode's session and agent ids (Ampersand session metadata) and the configured
 *   `sender` / `channel` (Ampersand message metadata), so the server-side transcript records who said what.
 */
import { Model, Plugin, Provider } from "@opencode/plugin"
import { DEFAULT_MODEL } from "./ampersand/client.js"
import { PROVIDER } from "./settings.js"

export const PACKAGE = "opencode-humansand"
export const PROVIDER_ID = Provider.ID.make(PROVIDER)
export const MODEL_ID = Model.ID.make(DEFAULT_MODEL)

/** `plugins: [{ package: "opencode-humansand", options: { ... } }]` */
export interface PluginConfig {
  /** `sender` stamped on user messages. Default `user`. */
  readonly sender?: string
  /** `channel` stamped on user messages. Default `opencode`. */
  readonly channel?: string
  /** Ampersand server-side compaction. Default `auto`. */
  readonly serverCompaction?: "auto" | "disabled"
  /** Whether the agent may end a turn with no text and no tool call. Default `true`. */
  readonly allowSilentCompletion?: boolean
  /**
   * How OpenCode session titles are produced when Ampersand is the model. `local` (default) derives the title from
   * the first user message without a model call; `model` lets OpenCode ask Ampersand, which creates and strands one
   * Ampersand session per OpenCode session.
   */
  readonly titles?: "local" | "model"
}

/**
 * First user text in an OpenCode request, trimmed to one line of at most `max` characters. OpenCode frames the
 * title request as `Here is the first message of the conversation: <message>…</message>` (or `<conversation>`);
 * the framing is stripped so the title is the user's own words.
 */
export function localTitle(
  messages: ReadonlyArray<{ readonly role: string; readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string | null | undefined }> }>,
  max = 80,
): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue
    const text = message.content
      .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
      .join(" ")
    const unwrapped = /<(message|conversation)>([\s\S]*?)<\/\1>/.exec(text)?.[2] ?? text
    const line = unwrapped.replace(/\s+/g, " ").trim()
    if (line.length === 0) continue
    return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`
  }
  return undefined
}

/** The AI SDK entry (`index.js` / `index.ts`) that sits next to this file, as an `aisdk:file://` package spec. */
export function selfPackage(): string {
  const entry = new URL(import.meta.url).href.replace(/server\.(js|ts)$/, "index.$1")
  return `aisdk:${entry}`
}

export function ampersandModel(): Model.Info {
  return {
    id: MODEL_ID,
    modelID: MODEL_ID,
    providerID: PROVIDER_ID,
    name: "Ampersand v0.1",
    family: Model.Family.make("ampersand"),
    capabilities: { tools: true, input: ["text"], output: ["text"], temperature: false },
    variants: [],
    time: { released: Date.UTC(2026, 9, 1) },
    cost: [
      {
        input: Model.Cost.fields.input.make(1),
        output: Model.Cost.fields.output.make(5.2),
        cache: { read: Model.Cost.fields.cache.fields.read.make(0.2), write: Model.Cost.fields.cache.fields.write.make(0) },
      },
    ],
    status: "beta",
    enabled: true,
    // Hosted limits (docs/GUIDES "Input limits"): 241,664 input tokens at high effort + 16,384 output, or 225,280 +
    // 32,768 at max, i.e. a 258,048-token model context. Output is the max-effort per-call ceiling.
    limit: { context: 258_048, output: 32_768 },
  }
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {})

const pluginSettings = (config: PluginConfig): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  if (config.sender !== undefined) out.sender = config.sender
  if (config.channel !== undefined) out.channel = config.channel
  if (config.serverCompaction !== undefined) out.serverCompaction = config.serverCompaction
  if (config.allowSilentCompletion !== undefined) out.allowSilentCompletion = config.allowSilentCompletion
  return out
}

export default Plugin.define({
  id: PACKAGE,
  async setup(ctx) {
    const config = record(ctx.options) as PluginConfig
    const pkg = selfPackage()

    await ctx.provider.transform((editor) => {
      const existing = editor.get(PROVIDER_ID)
      if (existing) {
        // models.dev or the user's config already defines the provider. Route it through the code on disk unless the
        // user pinned a package explicitly.
        editor.update(PROVIDER_ID, (provider) => {
          const current = provider.package
          if (current === undefined || current === PACKAGE || current === `aisdk:${PACKAGE}`) provider.package = pkg
          provider.settings = { ...pluginSettings(config), ...(provider.settings ?? {}) }
        })
        return
      }
      editor.add({
        info: {
          ...Provider.Info.empty(PROVIDER_ID),
          name: "humans&",
          package: pkg,
          activation: "auto",
          settings: pluginSettings(config),
        },
        models: [ampersandModel()],
      })
    })

    // Titles: one Ampersand session per OpenCode session just to name it is not worth it.
    await ctx.session.hook(
      "title",
      (input) => {
        if (config.titles === "model" || input.result !== undefined) return
        const title = localTitle(input.messages)
        if (title !== undefined) input.result = title
      },
      { providerID: PROVIDER_ID },
    )

    // Per-request provider options: the OpenCode session and agent ids travel as Ampersand session metadata.
    await ctx.session.hook(
      "context",
      (input) => {
        input.options.sessionMetadata = {
          ...record(input.options.sessionMetadata),
          opencode_session: input.sessionID,
          opencode_agent: input.agent,
        }
      },
      { providerID: PROVIDER_ID },
    )
  },
})
