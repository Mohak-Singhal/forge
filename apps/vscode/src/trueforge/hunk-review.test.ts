import { beforeEach, describe, expect, test } from "vitest"
import {
	allowUnreviewedEdits,
	clearHunkDecision,
	clearHunkDecisionForToolCall,
	clearHunkDecisions,
	isUnreviewedWriteAllowed,
	pendingDecisionCount,
	proposalKey,
	recordHunkDecisions,
	takeHunkDecisions,
} from "./hunk-review"

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

describe("takeHunkDecisions — fail closed", () => {
	beforeEach(() => {
		clearHunkDecisions()
		allowUnreviewedEdits(false)
	})

	test("reports unreviewed when nothing was recorded, never implicit consent", () => {
		const decision = takeHunkDecisions(proposalKey("p", hunks), 2)
		expect(decision.kind).toBe("unreviewed")
	})

	test("returns the recorded decisions", () => {
		const key = proposalKey("p", hunks)
		recordHunkDecisions(key, [true, false])
		expect(takeHunkDecisions(key, 2)).toEqual({ kind: "reviewed", accepted: [true, false] })
	})

	test("consumes the decisions so a second take is unreviewed, not all-accepted", () => {
		const key = proposalKey("p", hunks)
		recordHunkDecisions(key, [false, false])
		expect(takeHunkDecisions(key, 2)).toEqual({ kind: "reviewed", accepted: [false, false] })
		// The critical regression: a consumed review must not become a silent accept.
		expect(takeHunkDecisions(key, 2).kind).toBe("unreviewed")
		expect(pendingDecisionCount()).toBe(0)
	})

	test("treats a recording whose length does not match the proposal as unreviewed", () => {
		const key = proposalKey("p", hunks)
		recordHunkDecisions(key, [true])
		const decision = takeHunkDecisions(key, 2)
		expect(decision.kind).toBe("unreviewed")
	})

	test("keeps decisions for different proposals apart", () => {
		const first = proposalKey("a.py", hunks)
		const second = proposalKey("b.py", hunks)
		recordHunkDecisions(first, [true, false])
		recordHunkDecisions(second, [false, true])
		expect(takeHunkDecisions(first, 2)).toEqual({ kind: "reviewed", accepted: [true, false] })
		expect(takeHunkDecisions(second, 2)).toEqual({ kind: "reviewed", accepted: [false, true] })
	})

	test("bounds the number of unconsumed reviews", () => {
		for (let i = 0; i < 60; i++) {
			recordHunkDecisions(proposalKey(`f${i}.py`, hunks), [true, true])
		}
		expect(pendingDecisionCount()).toBeLessThanOrEqual(50)
	})
})

describe("review lifecycle bound to the tool call", () => {
	beforeEach(() => {
		clearHunkDecisions()
		allowUnreviewedEdits(false)
	})

	test("a denied tool call drops the review it collected", () => {
		const key = proposalKey("p", hunks)
		recordHunkDecisions(key, [true], "tool-call-1")
		expect(pendingDecisionCount()).toBe(1)
		clearHunkDecisionForToolCall("tool-call-1")
		expect(pendingDecisionCount()).toBe(0)
		// A later proposal of the same shape must not inherit the rejected call's answers.
		expect(takeHunkDecisions(key, 2).kind).toBe("unreviewed")
	})

	test("clearing an unknown tool call is a no-op", () => {
		const key = proposalKey("p", hunks)
		recordHunkDecisions(key, [true], "tool-call-1")
		clearHunkDecisionForToolCall("tool-call-other")
		expect(pendingDecisionCount()).toBe(1)
	})

	test("consuming a review drops its tool-call binding", () => {
		const key = proposalKey("p", hunks)
		recordHunkDecisions(key, [true, true], "tool-call-1")
		expect(takeHunkDecisions(key, 2).kind).toBe("reviewed")
		// The tool call can no longer clear a review that is already gone.
		clearHunkDecisionForToolCall("tool-call-1")
		expect(pendingDecisionCount()).toBe(0)
	})

	test("clearHunkDecision drops a review that could not be shown", () => {
		const key = proposalKey("p", hunks)
		recordHunkDecisions(key, [true], "tool-call-1")
		clearHunkDecision(key)
		expect(takeHunkDecisions(key, 2).kind).toBe("unreviewed")
	})
})

describe("headless seam", () => {
	beforeEach(() => {
		clearHunkDecisions()
		allowUnreviewedEdits(false)
	})

	test("is off by default, so the extension cannot write unreviewed", () => {
		expect(isUnreviewedWriteAllowed()).toBe(false)
	})

	test("can be enabled explicitly for automated tests and turned back off", () => {
		allowUnreviewedEdits(true)
		expect(isUnreviewedWriteAllowed()).toBe(true)
		allowUnreviewedEdits(false)
		expect(isUnreviewedWriteAllowed()).toBe(false)
	})
})
