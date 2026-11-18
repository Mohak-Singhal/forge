/**
 * Adversarial tests for the Forge write path.
 *
 * The bug these pin down: `editor_propose_edit` used to default to applying every hunk
 * when no review had been recorded. Combined with the MCP auto-approval toggle (on by
 * default), an interactive edit could reach disk with the user never seeing a diff.
 * These tests drive the real `callEditorTool` against a temp workspace and assert the
 * file is untouched unless a review was actually recorded.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
	allowUnreviewedEdits,
	clearHunkDecisionForToolCall,
	clearHunkDecisions,
	proposalKey,
	recordHunkDecisions,
} from "./hunk-review"
import { callEditorTool } from "./mcp/tools"

const ORIGINAL = `def get_debug_flag():
    val = os.environ.get("FLASK_DEBUG")
    return val not in ("0", "false", "no")
`

let root: string

beforeEach(() => {
	clearHunkDecisions()
	allowUnreviewedEdits(false)
	root = mkdtempSync(join(tmpdir(), "forge-write-"))
	writeFileSync(join(root, "helpers.py"), ORIGINAL, "utf8")
})

afterEach(() => {
	clearHunkDecisions()
	allowUnreviewedEdits(false)
	rmSync(root, { recursive: true, force: true })
})

const hunks = [
	{
		oldText: 'return val not in ("0", "false", "no")',
		newText: 'return val not in ("0", "false", "no", "off", "n")',
	},
]

async function propose() {
	return callEditorTool("editor_propose_edit", { path: "helpers.py", summary: "treat off/n as false", edits: hunks }, { root })
}

describe("editor_propose_edit — review gate", () => {
	test("refuses to write when no hunk review was recorded", async () => {
		const result = JSON.parse(await propose())
		expect(result.status).toBe("unreviewed")
		expect(result.applied).toBe(0)
		// The whole point: the file on disk is byte-identical.
		expect(readFileSync(join(root, "helpers.py"), "utf8")).toBe(ORIGINAL)
	})

	test("writes when the review accepted every hunk", async () => {
		recordHunkDecisions(proposalKey("helpers.py", hunks), [true])
		const result = JSON.parse(await propose())
		expect(result.status).toBe("applied")
		expect(result.hunks).toBe(1)
		expect(readFileSync(join(root, "helpers.py"), "utf8")).toContain('"off", "n"')
	})

	test("applies only the accepted hunk when the review rejected one", async () => {
		const twoHunks = [hunks[0], { oldText: "def get_debug_flag():", newText: "def get_debug_flag() -> bool:" }]
		recordHunkDecisions(proposalKey("helpers.py", twoHunks), [true, false])
		const result = JSON.parse(
			await callEditorTool("editor_propose_edit", { path: "helpers.py", summary: "two hunks", edits: twoHunks }, { root }),
		)
		expect(result.status).toBe("applied")
		expect(result.declinedHunks).toBe(1)
		const written = readFileSync(join(root, "helpers.py"), "utf8")
		expect(written).toContain('"off", "n"')
		// The rejected hunk must not have landed.
		expect(written).toContain("def get_debug_flag():")
		expect(written).not.toContain("-> bool:")
	})

	test("writes nothing when the review rejected every hunk", async () => {
		recordHunkDecisions(proposalKey("helpers.py", hunks), [false])
		const result = JSON.parse(await propose())
		expect(result.status).toBe("rejected")
		expect(readFileSync(join(root, "helpers.py"), "utf8")).toBe(ORIGINAL)
	})

	test("a review for a different proposal cannot be consumed by this one", async () => {
		// Record a review keyed to a different path; this proposal must stay unreviewed.
		recordHunkDecisions(proposalKey("other.py", hunks), [true])
		const result = JSON.parse(await propose())
		expect(result.status).toBe("unreviewed")
		expect(readFileSync(join(root, "helpers.py"), "utf8")).toBe(ORIGINAL)
	})

	test("a second identical proposal cannot reuse the first proposal's decisions", async () => {
		recordHunkDecisions(proposalKey("helpers.py", hunks), [true])
		expect(JSON.parse(await propose()).status).toBe("applied")
		// Same content proposed again: the review was consumed, so this must refuse.
		const second = JSON.parse(await propose())
		expect(second.status).toBe("unreviewed")
	})

	test("the explicit headless seam still allows an unreviewed write", async () => {
		allowUnreviewedEdits(true)
		const result = JSON.parse(await propose())
		expect(result.status).toBe("applied")
		expect(readFileSync(join(root, "helpers.py"), "utf8")).toContain('"off", "n"')
	})

	// The review is collected before the harness approval buttons are shown. If the user
	// reviews the hunks and then rejects the tool call, that review must die with the
	// call — otherwise an identical re-proposal could consume it without a new review.
	test("a denied call's review cannot be consumed by an identical later proposal", async () => {
		recordHunkDecisions(proposalKey("helpers.py", hunks), [true], "call-1")
		clearHunkDecisionForToolCall("call-1")
		const result = JSON.parse(await propose())
		expect(result.status).toBe("unreviewed")
		expect(readFileSync(join(root, "helpers.py"), "utf8")).toBe(ORIGINAL)
	})
})

describe("editor_undo_last_edit", () => {
	test("restores the exact pre-edit bytes", async () => {
		recordHunkDecisions(proposalKey("helpers.py", hunks), [true])
		const applied = JSON.parse(await propose())
		expect(applied.status).toBe("applied")
		expect(readFileSync(join(root, "helpers.py"), "utf8")).not.toBe(ORIGINAL)

		const undone = JSON.parse(await callEditorTool("editor_undo_last_edit", { proposalId: applied.proposalId }, { root }))
		expect(undone.status).toBe("undone")
		expect(readFileSync(join(root, "helpers.py"), "utf8")).toBe(ORIGINAL)
	})

	test("refuses to overwrite a file that changed after the edit", async () => {
		recordHunkDecisions(proposalKey("helpers.py", hunks), [true])
		const applied = JSON.parse(await propose())
		// A later, unrelated change lands on disk.
		const newer = `${readFileSync(join(root, "helpers.py"), "utf8")}\n# newer user edit\n`
		writeFileSync(join(root, "helpers.py"), newer, "utf8")

		const undone = JSON.parse(await callEditorTool("editor_undo_last_edit", { proposalId: applied.proposalId }, { root }))
		expect(undone.status).toBe("stale")
		// The newer content survives untouched.
		expect(readFileSync(join(root, "helpers.py"), "utf8")).toBe(newer)
	})
})
