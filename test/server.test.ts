import { describe, expect, test } from "bun:test"
import { localTitle } from "../src/server.ts"

const user = (text: string) => [{ role: "user", content: [{ type: "text", text }] }]

describe("localTitle", () => {
  test("uses the first user message", () => {
    expect(localTitle(user("  fix the   failing test\nplease "))).toBe("fix the failing test please")
  })

  test("strips OpenCode's title-request framing", () => {
    const framed =
      "Here is the first message of the conversation:\n\n<message>\nthe test suite is failing. find out why\n</message>\n\nReply with only the title."
    expect(localTitle(user(framed))).toBe("the test suite is failing. find out why")
    const conversation = "Here is the conversation so far:\n\n<conversation>\nuser: hi\nassistant: hello\n</conversation>\n\nReply with only the title."
    expect(localTitle(user(conversation))).toBe("user: hi assistant: hello")
  })

  test("truncates long titles with an ellipsis", () => {
    const title = localTitle(user("x".repeat(100)), 20)
    expect(title).toHaveLength(20)
    expect(title?.endsWith("…")).toBe(true)
  })

  test("skips system messages and empty text", () => {
    expect(localTitle([{ role: "system", content: [{ type: "text", text: "sys" }] }, ...user("   "), ...user("real")])).toBe("real")
  })
})
