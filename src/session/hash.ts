import { createHash } from "node:crypto"

/** Deterministic JSON: object keys sorted recursively, `undefined` dropped. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key]
      if (entry !== undefined) out[key] = sortKeys(entry)
    }
    return out
  }
  return value
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

export const shortHash = (input: string): string => sha256(input).slice(0, 24)
