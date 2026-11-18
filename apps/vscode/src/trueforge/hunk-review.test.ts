import { beforeEach, describe, expect, test } from "vitest"
import { clearHunkDecisions, pendingDecisionCount, proposalKey, recordHunkDecisions, takeHunkDecisions } from "./hunk-review"

const hunks = [
	{ oldText: "a", newText: "A" },
	{ oldText: "b", newText: "B" },
]

describe("proposalKey", () => {
	beforeEach(() => clearHunkDecisions())

	test("is stable for the same path and hunks", () => {
		expect(proposalKey("src/a.py", hunks)).toBe(proposalKey("src/a.py", hunks))
	})

	test("differs when the path differs", () => {
		expect(proposalKey("src/a.py", hunks)).not.toBe(proposalKey("src/b.py", hunks))
	})

	test("differs when a hunk body differs", () => {
		const changed = [{ ...hunks[0], newText: "Z" }, hunks[1]]
		expect(proposalKey("src/a.py", hunks)).not.toBe(proposalKey("src/a.py", changed))
	})

	test("differs when the hunk count differs", () => {
		expect(proposalKey("src/a.py", hunks)).not.toBe(proposalKey("src/a.py", [hunks[0]]))
	})

	test("ignores the intent hint, which is display-only", () => {
		const withIntent = hunks.map((hunk) => ({ ...hunk, intent: "because" }))
		expect(proposalKey("src/a.py", withIntent)).toBe(proposalKey("src/a.py", hunks))
	})
})

describe("takeHunkDecisions", () => {
	beforeEach(() => clearHunkDecisions())

	test("defaults to accepting everything when nothing was recorded", () => {
		expect(takeHunkDecisions(proposalKey("p", hunks), 2)).toEqual([true, true])
	})

	test("returns the recorded decisions", () => {
		const key = proposalKey("p", hunks)
		recordHunkDecisions(key, [true, false])
		expect(takeHunkDecisions(key, 2)).toEqual([true, false])
	})

	test("consumes the decisions so a second take falls back to all-accepted", () => {
		const key = proposalKey("p", hunks)
		recordHunkDecisions(key, [false, false])
		expect(takeHunkDecisions(key, 2)).toEqual([false, false])
		expect(takeHunkDecisions(key, 2)).toEqual([true, true])
		expect(pendingDecisionCount()).toBe(0)
	})

	test("ignores a recording whose length does not match the proposal", () => {
		const key = proposalKey("p", hunks)
		recordHunkDecisions(key, [true])
		expect(takeHunkDecisions(key, 2)).toEqual([true, true])
	})

	test("keeps decisions for different proposals apart", () => {
		const first = proposalKey("a.py", hunks)
		const second = proposalKey("b.py", hunks)
		recordHunkDecisions(first, [true, false])
		recordHunkDecisions(second, [false, true])
		expect(takeHunkDecisions(first, 2)).toEqual([true, false])
		expect(takeHunkDecisions(second, 2)).toEqual([false, true])
	})

	test("bounds the number of unconsumed reviews", () => {
		for (let i = 0; i < 60; i++) {
			recordHunkDecisions(proposalKey(`f${i}.py`, hunks), [true, true])
		}
		expect(pendingDecisionCount()).toBeLessThanOrEqual(50)
	})
})
