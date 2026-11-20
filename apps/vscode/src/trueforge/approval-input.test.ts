import { describe, expect, test } from "vitest"
import { resolveApprovalInput } from "./trueforge-session-host"

const tracked = JSON.stringify({
	path: "src/flask/helpers.py",
	summary: "extend false values",
	edits: [{ oldText: "a", newText: "b" }],
})

describe("resolveApprovalInput", () => {
	test("uses the tracked arguments when the harness sends an empty input", () => {
		const resolved = resolveApprovalInput({}, tracked) as { path: string; edits: unknown[] }
		expect(resolved.path).toBe("src/flask/helpers.py")
		expect(resolved.edits).toHaveLength(1)
	})

	test("uses the tracked arguments when input is absent", () => {
		const resolved = resolveApprovalInput(undefined, tracked) as { path: string }
		expect(resolved.path).toBe("src/flask/helpers.py")
	})

	test("prefers a populated approval input", () => {
		const provided = { path: "from-approval.py" }
		expect(resolveApprovalInput(provided, tracked)).toBe(provided)
	})

	test("keeps a populated input even when the tracked arguments differ", () => {
		const provided = { path: "from-approval.py", edits: [] }
		const resolved = resolveApprovalInput(provided, tracked) as { path: string }
		expect(resolved.path).toBe("from-approval.py")
	})

	test("falls back to a raw wrapper when tracked arguments are not JSON", () => {
		expect(resolveApprovalInput({}, "not json")).toEqual({ raw: "not json" })
	})

	test("returns the empty input untouched when there is nothing tracked", () => {
		expect(resolveApprovalInput({}, undefined)).toEqual({})
	})

	test("handles a null approval input", () => {
		expect(resolveApprovalInput(null, tracked)).toBeNull()
	})
})
