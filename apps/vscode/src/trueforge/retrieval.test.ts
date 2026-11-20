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
import { isDocPath, isTestPath, queryTokens, retrieveCode, retrieveContext } from "./retrieval"

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

describe("retrieveContext symbol links and coverage", () => {
	function makeRepo(): string {
		const dir = mkdtempSync(join(tmpdir(), "forge-plan-"))
		const put = (rel: string, body: string) => {
			const abs = join(dir, rel)
			mkdirSync(join(abs, ".."), { recursive: true })
			writeFileSync(abs, body, "utf8")
		}
		put(
			"src/app/cli.py",
			[
				"import click",
				"",
				"class FlaskGroup(click.Group):",
				"    pass",
				"",
				"def run_command():",
				"    pass",
				"",
				"@click.command()",
				"def config_command():",
				'    """Print the application configuration as JSON, masking secrets."""',
				"    print(masked)",
				"",
			].join("\n"),
		)
		put(
			"tests/test_cli.py",
			[
				"from app.cli import FlaskGroup",
				"from app.cli import run_command",
				"",
				"def test_config_command_masks_secrets():",
				"    runner = FlaskGroup()",
				"    run_command()",
				"",
			].join("\n"),
		)
		put(
			"docs/cli.rst",
			[
				"Command Line Interface",
				"======================",
				"",
				"The :func:`run <app.cli.run_command>` command starts the server.",
				"Create an instance of :class:`~app.cli.FlaskGroup`:",
				"",
			].join("\n"),
		)
		put(
			"docs/api.rst",
			[
				"Command Line Interface",
				"----------------------",
				"",
				".. autoclass:: FlaskGroup",
				".. autodata:: run_command",
				"",
			].join("\n"),
		)
		put("src/app/testing.py", "# prose about commands and json and config\nclass EnvironBuilder:\n    pass\n")
		return dir
	}

	test("surfaces implementation, test and docs for a task that asks for all three", () => {
		const dir = makeRepo()
		try {
			const plan = retrieveContext(
				dir,
				"Add a new built-in CLI command that prints the application configuration as JSON masking secrets. It must be covered by a test and documented alongside the other commands.",
				{ maxChunks: 8 },
			)
			expect(plan.intent).toEqual({ tests: true, docs: true })
			const paths = plan.chunks.map((chunk) => chunk.path)
			expect(paths).toContain("src/app/cli.py")
			expect(paths).toContain("tests/test_cli.py")
			expect(paths).toContain("docs/cli.rst")
			expect(paths).toContain("docs/api.rst")
			expect(plan.chunks.length).toBeLessThanOrEqual(8)
			expect(plan.chunks.filter((chunk) => chunk.path === "src/app/cli.py").length).toBeLessThanOrEqual(2)
			expect(plan.chunks.some((chunk) => chunk.why?.startsWith("links to"))).toBe(true)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test("does not force test/doc coverage when the task does not ask for it", () => {
		const dir = makeRepo()
		try {
			const plan = retrieveContext(dir, "Print the application configuration as JSON masking secrets", { maxChunks: 6 })
			expect(plan.intent).toEqual({ tests: false, docs: false })
			expect(plan.chunks[0]?.path).toBe("src/app/cli.py")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test("is deterministic across repeated runs", () => {
		const dir = makeRepo()
		try {
			const query = "Add a CLI command printing config as JSON, with a test and docs"
			const a = retrieveContext(dir, query, { maxChunks: 8 }).chunks.map((c) => `${c.path}:${c.startLine}`)
			const b = retrieveContext(dir, query, { maxChunks: 8 }).chunks.map((c) => `${c.path}:${c.startLine}`)
			expect(a).toEqual(b)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe("path roles", () => {
	test("classifies test and doc paths without repository names", () => {
		expect(isTestPath("tests/test_cli.py")).toBe(true)
		expect(isTestPath("src/app/cli.py")).toBe(false)
		expect(isDocPath("docs/cli.rst")).toBe(true)
		expect(isDocPath("README.md")).toBe(true)
		expect(isDocPath("src/app/cli.py")).toBe(false)
	})
})
