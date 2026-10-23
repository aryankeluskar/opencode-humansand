import { expect, test } from "bun:test"
import { slugify } from "../src/slugify"

test("collapses punctuation and spaces", () => {
  expect(slugify("Ampersand & OpenCode")).toBe("ampersand-opencode")
})

test("trims leading and trailing separators", () => {
  expect(slugify("  Hello, World!  ")).toBe("hello-world")
})

test("leaves clean slugs alone", () => {
  expect(slugify("already-clean")).toBe("already-clean")
})
