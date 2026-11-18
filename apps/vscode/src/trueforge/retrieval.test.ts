/**
 * Retrieval ranking regression tests.
 *
 * The defect these pin down: without stopword filtering, filler words in a task
 * description ("as", "in", "that", "add", "new") scored like real signal, and a
 * prose-heavy file could outrank the module the task was actually about. A question
 * about a CLI command surfaced `testing.py` above `cli.py`.
 *
 * These run against a small synthetic repo so they are deterministic and fast, and
 * they assert on relative ordering rather than absolute BM25 scores.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { queryTokens, retrieveCode } from "./retrieval"

let root: string

function write(rel: string, body: string) {
	const abs = join(root, rel)
	mkdirSync(join(abs, ".."), { recursive: true })
	writeFileSync(abs, body, "utf8")
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "forge-rank-"))
	// The module the task is about.
	write(
		"src/app/cli.py",
		[
			"import click",
			"",
			"@click.group()",
			"def cli():",
			'    """Flask command line interface."""',
			"",
			"",
			"@cli.command()",
			"def config_command():",
			'    """Print the application config as JSON, masking secrets."""',
			"    print(json.dumps(masked))",
			"",
		].join("\n"),
	)
	// A file that merely mentions the words in prose.
	write(
		"src/app/testing.py",
		[
			"# Test helpers that mention the cli, commands, json and config as prose.",
			"# This file talks about the command line as a concept, in sentences that",
			"# contain many of the same words without implementing any command.",
			"class EnvironBuilder:",
			"    pass",
			"",
		].join("\n"),
	)
	write("docs/cli.rst", "Command Line Interface\n======================\n\nBuilt-in commands.\n")
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

describe("queryTokens", () => {
	test("drops filler words that carry no signal", () => {
		const tokens = queryTokens("add a new CLI command that prints config as JSON")
		expect(tokens).not.toContain("add")
		expect(tokens).not.toContain("new")
		expect(tokens).not.toContain("that")
		expect(tokens).not.toContain("as")
		expect(tokens).toContain("cli")
		expect(tokens).toContain("command")
		expect(tokens).toContain("config")
		expect(tokens).toContain("json")
	})

	test("falls back to the raw tokens when the query is all filler", () => {
		// Better to search for something than to silently return nothing.
		expect(queryTokens("the a of").length).toBeGreaterThan(0)
	})
})

describe("retrieveCode ranking", () => {
	test("ranks the implementing module above a file that only mentions the words", () => {
		const hits = retrieveCode(root, "add a new CLI command that prints application config as JSON masking secrets", 8)
		expect(hits.length).toBeGreaterThan(0)
		const paths = hits.map((h) => h.path)
		const cliIndex = paths.indexOf("src/app/cli.py")
		const testingIndex = paths.indexOf("src/app/testing.py")
		expect(cliIndex).toBeGreaterThanOrEqual(0)
		if (testingIndex >= 0) {
			expect(cliIndex).toBeLessThan(testingIndex)
		}
	})

	test("is deterministic across repeated runs", () => {
		const query = "CLI command printing config as JSON"
		const first = retrieveCode(root, query, 5).map((h) => `${h.path}:${h.startLine}`)
		const second = retrieveCode(root, query, 5).map((h) => `${h.path}:${h.startLine}`)
		expect(first).toEqual(second)
	})

	test("reports the matched terms so a pick can be explained", () => {
		const hits = retrieveCode(root, "CLI command config JSON", 5)
		expect(hits[0]?.matchedTerms.length).toBeGreaterThan(0)
	})
})
