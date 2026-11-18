/**
 * Explicit-mention resolution.
 *
 * The defect these pin down: `@file.py:40-80` lost its range during parsing, so the
 * editor resolved the whole file (up to 400 lines) instead of the lines the user
 * pointed at. The range is now carried through parsing and sliced at resolution time,
 * and an explicit mention is never evicted by retrieval.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { resolveMentionContext } from "./mcp/tools"

let root: string

function write(rel: string, body: string) {
	const abs = join(root, rel)
	mkdirSync(join(abs, ".."), { recursive: true })
	writeFileSync(abs, body, "utf8")
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "forge-mentions-"))
	const lines = Array.from({ length: 120 }, (_, index) => `line_${index + 1} = ${index + 1}`)
	write("src/app/module.py", lines.join("\n"))
	write(
		"src/app/cli.py",
		[
			"import click",
			"",
			"class FlaskGroup(click.Group):",
			'    """A click Group that loads the app."""',
			"",
			"    def add_command(self, command):",
			"        super().add_command(command)",
			"",
			"def routes_command():",
			'    """Show the routes."""',
		].join("\n"),
	)
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

describe("resolveMentionContext", () => {
	test("resolves an explicit @file mention to the whole file", () => {
		const result = resolveMentionContext({ root }, "read @src/app/module.py please")
		expect(result.files).toEqual(["src/app/module.py"])
		expect(result.contextText).toContain("src/app/module.py:1-")
		expect(result.contextText).toContain("line_1 = 1")
	})

	test("honours @file:line-range instead of resolving the whole file", () => {
		const result = resolveMentionContext({ root }, "look at @src/app/module.py:40-45")
		expect(result.files).toEqual(["src/app/module.py:40-45"])
		expect(result.contextText).toContain("src/app/module.py:40-45")
		expect(result.contextText).toContain("40\tline_40 = 40")
		expect(result.contextText).toContain("45\tline_45 = 45")
		// Outside the requested range must not be included.
		expect(result.contextText).not.toContain("line_1 = 1")
		expect(result.contextText).not.toContain("line_100 = 100")
	})

	test("resolves a bare @symbol to its definition body", () => {
		const result = resolveMentionContext({ root }, "how does @FlaskGroup work?")
		expect(result.symbols).toEqual(["FlaskGroup"])
		expect(result.contextText).toContain("src/app/cli.py:")
		expect(result.contextText).toContain("class FlaskGroup")
	})

	test("keeps multiple explicit mentions, in order", () => {
		const result = resolveMentionContext({ root }, "@src/app/cli.py and @routes_command and @src/app/module.py:1-3")
		expect(result.files).toEqual(["src/app/cli.py", "src/app/module.py:1-3"])
		expect(result.symbols).toEqual(["routes_command"])
	})

	test("reports an unresolved mention instead of silently dropping it", () => {
		const result = resolveMentionContext({ root }, "look at @src/app/missing.py")
		expect(result.contextText).toContain("unresolved mentions")
		expect(result.contextText).toContain("@src/app/missing.py")
	})

	test("removes mention tokens from the prompt text sent to the model", () => {
		const result = resolveMentionContext({ root }, "@src/app/cli.py add a config command")
		expect(result.promptText).toBe("add a config command")
	})

	test("without mentions there is no context block", () => {
		const result = resolveMentionContext({ root }, "add a config command")
		expect(result.contextText).toBe("")
		expect(result.promptText).toBe("add a config command")
	})

	test("an oversized mention is reported as not fitting the budget, never silently truncated", () => {
		const result = resolveMentionContext({ root }, "@src/app/module.py", 5)
		expect(result.contextText).toContain("does not fit the remaining mention budget")
	})
})
