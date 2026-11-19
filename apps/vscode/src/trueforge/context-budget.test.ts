import { describe, expect, test } from "vitest"
import { estimateTokens, formatPackedContext, packContext, truncateToTokens } from "./context-budget"

function candidate(path: string, score: number, chars: number) {
	return {
		path,
		startLine: 1,
		endLine: 10,
		score,
		text: "x".repeat(chars),
		matchedTerms: ["config", "mask"],
	}
}

describe("estimateTokens", () => {
	test("is zero for empty text", () => {
		expect(estimateTokens("")).toBe(0)
	})

	test("grows with length and is conservative", () => {
		expect(estimateTokens("a".repeat(360))).toBe(100)
		expect(estimateTokens("a".repeat(3600))).toBe(1000)
	})
})

describe("truncateToTokens", () => {
	test("leaves short text untouched", () => {
		const result = truncateToTokens("short", 100)
		expect(result.truncated).toBe(false)
		expect(result.text).toBe("short")
	})

	test("cuts long text and says so", () => {
		const result = truncateToTokens("a\n".repeat(500), 20)
		expect(result.truncated).toBe(true)
		expect(result.text).toContain("truncated to fit the context budget")
		expect(estimateTokens(result.text)).toBeLessThanOrEqual(40)
	})
})

describe("packContext", () => {
	test("packs everything when the budget allows", () => {
		const packed = packContext([candidate("a.py", 10, 100), candidate("b.py", 5, 100)], { budgetTokens: 1000 })
		expect(packed.chunks).toHaveLength(2)
		expect(packed.dropped).toHaveLength(0)
		expect(packed.usedTokens).toBeGreaterThan(0)
		expect(packed.usedTokens).toBeLessThanOrEqual(1000)
	})

	test("never exceeds the budget", () => {
		const candidates = Array.from({ length: 20 }, (_, i) => candidate(`f${i}.py`, 100 - i, 2000))
		const packed = packContext(candidates, { budgetTokens: 500, maxChunks: 20, maxChunkTokens: 200 })
		expect(packed.usedTokens).toBeLessThanOrEqual(500)
		let sum = 0
		for (const chunk of packed.chunks) {
			sum += chunk.tokens
		}
		expect(sum).toBe(packed.usedTokens)
	})

	test("ranks by score, not by input order", () => {
		const packed = packContext([candidate("low.py", 1, 50), candidate("high.py", 90, 50)], { budgetTokens: 1000 })
		expect(packed.chunks[0].path).toBe("high.py")
	})

	test("a single oversized chunk cannot evict the rest", () => {
		const huge = candidate("huge.py", 100, 100_000)
		const precise = [candidate("a.py", 90, 100), candidate("b.py", 80, 100), candidate("c.py", 70, 100)]
		const packed = packContext([huge, ...precise], { budgetTokens: 600, maxChunkTokens: 100 })
		expect(packed.chunks.map((chunk) => chunk.path)).toContain("a.py")
		expect(packed.chunks.map((chunk) => chunk.path)).toContain("c.py")
		expect(packed.chunks.find((chunk) => chunk.path === "huge.py")?.truncated).toBe(true)
	})

	test("records a reason for every drop", () => {
		const candidates = Array.from({ length: 5 }, (_, i) => candidate(`f${i}.py`, 10 - i, 500))
		const packed = packContext(candidates, { budgetTokens: 100, maxChunkTokens: 50 })
		expect(packed.dropped.length).toBeGreaterThan(0)
		for (const drop of packed.dropped) {
			expect(drop.reason.length).toBeGreaterThan(0)
		}
	})

	test("respects the chunk cap", () => {
		const candidates = Array.from({ length: 10 }, (_, i) => candidate(`f${i}.py`, 10 - i, 10))
		const packed = packContext(candidates, { budgetTokens: 100_000, maxChunks: 3 })
		expect(packed.chunks).toHaveLength(3)
		expect(packed.dropped).toHaveLength(7)
	})

	test("explains why each chunk was kept", () => {
		const packed = packContext([candidate("a.py", 12.345, 100)], { budgetTokens: 1000 })
		expect(packed.chunks[0].reason).toContain("BM25 12.35")
		expect(packed.chunks[0].reason).toContain('"config"')
		expect(packed.chunks[0].reason).toContain("tok")
	})

	test("report states the budget and the drop count", () => {
		const packed = packContext([candidate("a.py", 1, 100), candidate("b.py", 0.5, 5000)], {
			budgetTokens: 100,
			maxChunkTokens: 50,
		})
		expect(packed.report).toContain("retrieval budget")
		expect(packed.report).toContain(`across ${packed.chunks.length} chunk(s)`)
	})
})

describe("formatPackedContext", () => {
	test("returns the report alone when nothing matched", () => {
		const packed = packContext([], { budgetTokens: 100 })
		expect(formatPackedContext(packed)).toContain("no chunks matched")
	})

	test("renders path, line range and reason for each chunk", () => {
		const packed = packContext([candidate("src/flask/cli.py", 9, 100)], { budgetTokens: 1000 })
		const text = formatPackedContext(packed)
		expect(text).toContain("## src/flask/cli.py:1-10")
		expect(text).toContain("BM25 9.00")
	})
})

describe("report header and link notes", () => {
	test("leads the report with the query/intent header", () => {
		const packed = packContext([{ path: "a.py", startLine: 1, endLine: 2, score: 1, text: "x", matchedTerms: ["x"] }], {
			header: 'query: "add a command" · intent: tests+docs',
		})
		expect(packed.report.split("\n")[0]).toBe('query: "add a command" · intent: tests+docs')
	})

	test("keeps the symbol-link note in the chunk reason", () => {
		const packed = packContext(
			[{ path: "docs/cli.rst", startLine: 1, endLine: 2, score: 1, text: "x", why: "links to FlaskGroup, run_command" }],
			{},
		)
		expect(packed.chunks[0]?.reason).toContain("links to FlaskGroup, run_command")
	})
})
