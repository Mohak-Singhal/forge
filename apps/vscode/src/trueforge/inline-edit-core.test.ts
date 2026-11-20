import { describe, expect, it } from "vitest"
import {
	applyAcceptedHunks,
	buildInlineEditPrompt,
	extractJsonObject,
	hasDocumentDrifted,
	type InlineEditRequest,
	inlineEditDocumentRejection,
	parseInlineEditReply,
	planInlineEdit,
	selectedRegion,
} from "./inline-edit-core"

const FILE = [
	"def get_debug_flag():",
	'    """Get the debug flag."""',
	"    val = os.environ.get('FLASK_DEBUG')",
	"    return val not in (None, '', '0', 'false')",
	"",
].join("\n")

function request(overrides: Partial<InlineEditRequest> = {}): InlineEditRequest {
	return {
		path: "src/flask/helpers.py",
		content: FILE,
		startLine: 1,
		endLine: 4,
		instruction: "treat off and n as false",
		...overrides,
	}
}

describe("selectedRegion", () => {
	it("returns the 1-based inclusive selection", () => {
		expect(selectedRegion(request({ startLine: 1, endLine: 1 }))).toBe("def get_debug_flag():")
		expect(selectedRegion(request({ startLine: 3, endLine: 4 }))).toBe(
			"    val = os.environ.get('FLASK_DEBUG')\n    return val not in (None, '', '0', 'false')",
		)
	})

	it("clamps out-of-range selections instead of throwing", () => {
		expect(selectedRegion(request({ startLine: 99, endLine: 200 }))).toBe("")
		expect(selectedRegion(request({ startLine: 0, endLine: 1 }))).toBe("def get_debug_flag():")
	})
})

describe("buildInlineEditPrompt", () => {
	it("pins the model to the region and demands JSON only", () => {
		const prompt = buildInlineEditPrompt(request())
		expect(prompt).toContain("src/flask/helpers.py")
		expect(prompt).toContain("lines 1-4")
		expect(prompt).toContain("def get_debug_flag():")
		expect(prompt).toContain("treat off and n as false")
		expect(prompt).toContain('{"edits":')
		expect(prompt).toContain("must occur exactly once")
	})
})

describe("extractJsonObject", () => {
	it("parses bare JSON", () => {
		expect(extractJsonObject('{"edits":[]}')).toEqual({ edits: [] })
	})

	it("parses JSON inside a code fence", () => {
		expect(extractJsonObject('```json\n{"edits":[{"oldText":"a","newText":"b"}]}\n```')).toEqual({
			edits: [{ oldText: "a", newText: "b" }],
		})
	})

	it("recovers JSON wrapped in prose", () => {
		expect(extractJsonObject('Here you go:\n{"edits":[]}\nHope that helps.')).toEqual({ edits: [] })
	})

	it("throws when there is no JSON at all", () => {
		expect(() => extractJsonObject("I cannot help with that.")).toThrow(/no JSON object/)
	})
})

describe("parseInlineEditReply", () => {
	it("returns hunks with intent", () => {
		const hunks = parseInlineEditReply('{"edits":[{"oldText":"a","newText":"b","intent":"rename"}]}')
		expect(hunks).toEqual([{ oldText: "a", newText: "b", intent: "rename" }])
	})

	it("treats a missing edits array as no changes", () => {
		expect(parseInlineEditReply("{}")).toEqual([])
	})

	it("rejects a hunk without oldText/newText", () => {
		expect(() => parseInlineEditReply('{"edits":[{"oldText":"a"}]}')).toThrow(/missing oldText\/newText/)
	})
})

describe("planInlineEdit", () => {
	it("applies a clean hunk and returns the proposed content", () => {
		const reply = JSON.stringify({
			edits: [
				{
					oldText: "    return val not in (None, '', '0', 'false')",
					newText: "    return str(val).lower() not in (None, '', '0', 'false', 'off', 'n')",
				},
			],
		})
		const plan = planInlineEdit(request(), reply)
		expect(plan.rejected).toEqual([])
		expect(plan.hunks).toHaveLength(1)
		expect(plan.proposed).toContain("'off', 'n'")
	})

	it("reports a stale hunk instead of silently dropping it", () => {
		const reply = JSON.stringify({ edits: [{ oldText: "text that is not in the file", newText: "x" }] })
		const plan = planInlineEdit(request(), reply)
		expect(plan.rejected).toHaveLength(1)
		expect(plan.rejected[0].reason).toMatch(/not found/)
		expect(plan.proposed).toBe(FILE)
	})

	it("returns the original content when the model proposes nothing", () => {
		const plan = planInlineEdit(request(), '{"edits":[]}')
		expect(plan.hunks).toEqual([])
		expect(plan.proposed).toBe(FILE)
	})
})

describe("applyAcceptedHunks", () => {
	const hunks = [
		{ oldText: "def get_debug_flag():", newText: "def get_debug_flag() -> bool:" },
		{ oldText: "    val = os.environ.get('FLASK_DEBUG')", newText: "    val = os.environ.get('FLASK_DEBUG', '')" },
	]

	it("applies only accepted hunks", () => {
		const result = applyAcceptedHunks(FILE, hunks, [true, false])
		expect(result.applied).toBe(1)
		expect(result.content).toContain("-> bool:")
		expect(result.content).toContain("os.environ.get('FLASK_DEBUG')")
	})

	it("leaves the file untouched when everything is rejected", () => {
		const result = applyAcceptedHunks(FILE, hunks, [false, false])
		expect(result.applied).toBe(0)
		expect(result.content).toBe(FILE)
	})

	it("applies both when both are accepted", () => {
		const result = applyAcceptedHunks(FILE, hunks, [true, true])
		expect(result.applied).toBe(2)
		expect(result.content).toContain("-> bool:")
		expect(result.content).toContain("'FLASK_DEBUG', ''")
	})
})

describe("inlineEditDocumentRejection", () => {
	it("accepts a real file", () => {
		expect(inlineEditDocumentRejection({ uriScheme: "file", isUntitled: false, isClosed: false })).toBeUndefined()
	})

	it("rejects a diff preview document", () => {
		// The regression: an active Forge diff tab made the inline edit read the preview
		// (already-proposed) text instead of the workspace file.
		expect(inlineEditDocumentRejection({ uriScheme: "forge-edit-preview", isUntitled: false, isClosed: false })).toMatch(
			/diff or preview/i,
		)
	})

	it("rejects any other non-file scheme", () => {
		expect(inlineEditDocumentRejection({ uriScheme: "untitled", isUntitled: false, isClosed: false })).toMatch(
			/diff or preview/i,
		)
		expect(inlineEditDocumentRejection({ uriScheme: "output", isUntitled: false, isClosed: false })).toMatch(
			/diff or preview/i,
		)
	})

	it("rejects an untitled buffer", () => {
		expect(inlineEditDocumentRejection({ uriScheme: "untitled", isUntitled: true, isClosed: false })).toMatch(/untitled/i)
	})

	it("rejects a closed document", () => {
		expect(inlineEditDocumentRejection({ uriScheme: "file", isUntitled: false, isClosed: true })).toMatch(/no longer open/i)
	})
})

describe("hasDocumentDrifted", () => {
	it("is false when the document is unchanged", () => {
		expect(hasDocumentDrifted(FILE, FILE)).toBe(false)
	})

	it("is true when the user edited during the model call", () => {
		expect(hasDocumentDrifted(`${FILE}\n# new line\n`, FILE)).toBe(true)
	})
})
