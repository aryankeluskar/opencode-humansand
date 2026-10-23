/**
 * Standalone mock Ampersand for driving OpenCode end-to-end.
 *   bun e2e/mock-server.ts <port> <script.json> <requests.jsonl>
 * `script.json` is an array of replies (see test/mock.ts `Reply`); every HTTP request is appended to `requests.jsonl`.
 */
import { appendFileSync, writeFileSync } from "node:fs"
import { MockAmpersand, type Reply } from "../test/mock.ts"

const [port, scriptPath, log] = process.argv.slice(2)
if (!port || !scriptPath || !log) {
  console.error("usage: bun e2e/mock-server.ts <port> <script.json> <requests.jsonl>")
  process.exit(2)
}
const script = (await Bun.file(scriptPath).json()) as Reply[]
writeFileSync(log, "")
const mock = new MockAmpersand({
  port: Number(port),
  script,
  onRequest: (request) => appendFileSync(log, `${JSON.stringify(request)}\n`),
})
console.log(`mock ampersand listening on ${mock.baseURL} with ${script.length} scripted replies`)
process.on("SIGTERM", () => {
  mock.stop()
  process.exit(0)
})
