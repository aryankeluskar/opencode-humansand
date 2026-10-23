import { NoSuchModelError, type LanguageModelV3, type ProviderV3 } from "@ai-sdk/provider"
import { createClient, DEFAULT_MODEL } from "./ampersand/client.js"
import { HumansandLanguageModel } from "./model.js"
import { PROVIDER, resolveApiKey, type HumansandSettings } from "./settings.js"

export interface HumansandProvider extends ProviderV3 {
  (modelId?: string): LanguageModelV3
  languageModel(modelId?: string): LanguageModelV3
  chat(modelId?: string): LanguageModelV3
}

/**
 * Create an AI SDK provider for humans& Ampersand. The only `create*` export of this package: OpenCode's AI SDK
 * bridge calls it with `{ name, apiKey, baseURL, headers, fetch, ...settings }`.
 */
export function createHumansand(settings: HumansandSettings = {}): HumansandProvider {
  const client = createClient({ baseURL: settings.baseURL, apiKey: resolveApiKey(settings), headers: settings.headers, fetch: settings.fetch })
  const key = settings.metadataKey ?? PROVIDER
  const languageModel = (modelId: string = DEFAULT_MODEL): LanguageModelV3 => new HumansandLanguageModel(modelId, { client, settings, key })
  return Object.assign((modelId?: string) => languageModel(modelId), {
    specificationVersion: "v3" as const,
    languageModel,
    chat: languageModel,
    embeddingModel: (modelId: string): never => {
      throw new NoSuchModelError({ modelId, modelType: "embeddingModel" })
    },
    imageModel: (modelId: string): never => {
      throw new NoSuchModelError({ modelId, modelType: "imageModel" })
    },
  }) as HumansandProvider
}
