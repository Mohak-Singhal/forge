/**
 * Hunk application boundary tests.
 *
 * The defect these pin down: a plain `indexOf` match let `VALUE = 1` replace the
 * prefix of `VALUE = 10`, and `return val` replace the prefix of `return value`.
 * A hunk must match a whole token, not a fragment of a longer identifier, while still
 * allowing legitimate partial-expression hunks that end on punctuation.
 */

import { describe, expect, test } from "vitest"
import { applyHunks, type EditHunk } from "./edits"

function apply(original: string, hunks: EditHunk[]) {
	return applyHunks(original, hunks)
}

describe("applyHunks token boundaries", () => {
	test("does not match the prefix of a longer number", () => {
		const result = apply("VALUE = 10\n", [{ oldText: "VALUE = 1", newText: "VALUE = 2" }])
		expect(result.applied).toBe(0)
		expect(result.rejected[0]?.reason).toMatch(/not found/)
		expect(result.proposed).toBeUndefined()
	})

	test("does not match the prefix of a longer identifier", () => {
		const result = apply("return value\n", [{ oldText: "return val", newText: "return result" }])
		expect(result.applied).toBe(0)
		expect(result.proposed).toBeUndefined()
	})

	test("still allows a partial expression that ends on punctuation", () => {
		const original = '    return val not in ("0", "false", "no")\n'
		const result = apply(original, [{ oldText: '("0", "false", "no")', newText: '("0", "false", "no", "off")' }])
		expect(result.applied).toBe(1)
		expect(result.proposed).toBe('    return val not in ("0", "false", "no", "off")\n')
	})

	test("still allows a whole-line replacement", () => {
		const result = apply("a\nb\nc\n", [{ oldText: "b", newText: "B" }])
		expect(result.applied).toBe(1)
		expect(result.proposed).toBe("a\nB\nc\n")
	})

	test("refuses an ambiguous match", () => {
		const result = apply("x = 1\nx = 1\n", [{ oldText: "x = 1", newText: "x = 2" }])
		expect(result.applied).toBe(0)
		expect(result.rejected[0]?.reason).toMatch(/multiple times/)
	})

	test("insertion hunks still append", () => {
		const result = apply("body\n", [{ oldText: "", newText: "tail\n" }])
		expect(result.applied).toBe(1)
		expect(result.proposed).toBe("body\ntail\n")
	})
})
