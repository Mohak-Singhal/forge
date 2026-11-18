import { describe, expect, test } from "vitest"
import { formatMentionContext, hasMentions, parseMentionRange, parseMentions, resolveFileMention } from "./mentions"

describe("parseMentions", () => {
	test("extracts a file mention with a path", () => {
		const parsed = parseMentions("look at @src/flask/cli.py and add a command")
		expect(parsed.files).toEqual(["src/flask/cli.py"])
		expect(parsed.symbols).toEqual([])
	})

	test("extracts a bare symbol mention", () => {
		const parsed = parseMentions("how does @FlaskGroup decide commands?")
		expect(parsed.symbols).toEqual(["FlaskGroup"])
		expect(parsed.files).toEqual([])
	})

	test("treats a bare filename with an extension as a file", () => {
		const parsed = parseMentions("in @cli.py the group adds commands")
		expect(parsed.files).toEqual(["cli.py"])
	})

	test("strips a line range from the path", () => {
		const parsed = parseMentions("see @tests/test_cli.py:40-80 for the pattern")
		expect(parsed.files).toEqual(["tests/test_cli.py"])
	})

	test("mixes files and symbols, preserving order", () => {
		const parsed = parseMentions("@src/flask/cli.py defines @FlaskGroup and @routes_command")
		expect(parsed.files).toEqual(["src/flask/cli.py"])
		expect(parsed.symbols).toEqual(["FlaskGroup", "routes_command"])
	})

	test("does not duplicate a repeated mention", () => {
		const parsed = parseMentions("@cli.py then @cli.py again")
		expect(parsed.files).toEqual(["cli.py"])
	})

	test("leaves email addresses and bare @ alone", () => {
		const parsed = parseMentions("mail me at a@b.com and use @ here")
		expect(parsed.files).toEqual([])
		expect(parsed.symbols).toEqual([])
	})

	test("removes mentions from the prompt text", () => {
		const parsed = parseMentions("@src/flask/cli.py add a config command")
		expect(parsed.text).toBe("add a config command")
	})

	test("keeps punctuation attached to surrounding prose", () => {
		const parsed = parseMentions("compare @cli.py, then decide.")
		expect(parsed.files).toEqual(["cli.py"])
	})
})

describe("hasMentions", () => {
	test("false for plain prose", () => {
		expect(hasMentions(parseMentions("add a command to the cli"))).toBe(false)
	})

	test("true with a file mention", () => {
		expect(hasMentions(parseMentions("@cli.py add a command"))).toBe(true)
	})
})

describe("parseMentionRange", () => {
	test("parses a plain path", () => {
		expect(parseMentionRange("src/flask/cli.py")).toEqual({ path: "src/flask/cli.py" })
	})

	test("parses a start-end range", () => {
		expect(parseMentionRange("src/flask/cli.py:10-20")).toEqual({
			path: "src/flask/cli.py",
			startLine: 10,
			endLine: 20,
		})
	})

	test("parses a single start line", () => {
		expect(parseMentionRange("cli.py:7")).toEqual({ path: "cli.py", startLine: 7 })
	})
})

describe("resolveFileMention", () => {
	const known = ["src/flask/cli.py", "tests/test_cli.py", "src/flask/helpers.py"]

	test("prefers an exact match", () => {
		expect(resolveFileMention("src/flask/cli.py", known)).toBe("src/flask/cli.py")
	})

	test("falls back to the shortest suffix match", () => {
		expect(resolveFileMention("cli.py", known)).toBe("src/flask/cli.py")
	})

	test("normalises leading ./ and backslashes", () => {
		expect(resolveFileMention(".\\src/flask/helpers.py", known)).toBe("src/flask/helpers.py")
	})

	test("returns undefined when nothing matches", () => {
		expect(resolveFileMention("nope.py", known)).toBeUndefined()
	})
})

describe("formatMentionContext", () => {
	test("is empty when there is nothing to show", () => {
		expect(formatMentionContext(parseMentions("hi"), [], [], 0, 100)).toBe("")
	})

	test("labels the block as ground truth and lists every resolved mention", () => {
		const mentions = parseMentions("@cli.py and @FlaskGroup")
		const text = formatMentionContext(
			mentions,
			[
				{ kind: "file", label: "cli.py", path: "src/flask/cli.py", startLine: 1, endLine: 3, text: "a\tb" },
				{ kind: "symbol", label: "FlaskGroup", path: "src/flask/cli.py", startLine: 9, endLine: 12, text: "c\td" },
			],
			[],
			40,
			6000,
		)
		expect(text).toContain("ground truth")
		expect(text).toContain("~40/6000 tokens")
		expect(text).toContain("@cli.py → src/flask/cli.py:1-3")
		expect(text).toContain("@FlaskGroup → src/flask/cli.py:9-12")
	})

	test("reports unresolved mentions instead of silently dropping them", () => {
		const text = formatMentionContext(parseMentions("@ghost.py"), [], ["ghost.py"], 0, 100)
		expect(text).toContain("unresolved mentions")
		expect(text).toContain("@ghost.py")
	})
})
