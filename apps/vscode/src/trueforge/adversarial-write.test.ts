/**
 * B2 adversarial write-path tests.
 *
 * Every case drives the real `callEditorTool` handler against a temp workspace. The
 * invariant under test: no interactive file write happens without a review decision
 * that applies to the current proposal, and a failed/stale/duplicate attempt leaves
 * the file's bytes untouched (or keeps the user's newer bytes).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { clearHunkDecisionForToolCall, clearHunkDecisions, proposalKey, recordHunkDecisions } from "./hunk-review"
import { callEditorTool, undoSnapshots } from "./mcp/tools"

const ORIGINAL = [
	"def get_debug_flag():",
	'    val = os.environ.get("FLASK_DEBUG")',
	'    return val not in ("0", "false", "no")',
	"",
].join("\n")

let root: string
const ctx = () => ({ root })
const read = () => readFileSync(join(root, "helpers.py"), "utf8")
const call = (args: Record<string, unknown>) => callEditorTool("editor_propose_edit", args, ctx())

function reviewed(path: string, hunks: Array<{ oldText: string; newText: string }>, accepted = hunks.map(() => true)) {
	recordHunkDecisions(proposalKey(path, hunks), accepted)
}

beforeEach(() => {
	clearHunkDecisions()
	undoSnapshots.clear()
	root = mkdtempSync(join(tmpdir(), "forge-adversarial-"))
	writeFileSync(join(root, "helpers.py"), ORIGINAL, "utf8")
})

afterEach(() => {
	clearHunkDecisions()
	undoSnapshots.clear()
	rmSync(root, { recursive: true, force: true })
})

describe("duplicate and reused approvals", () => {
	test("a review is consumed once; replaying the same proposal is refused", async () => {
		const hunks = [{ oldText: 'return val not in ("0", "false", "no")', newText: "return bool(val)" }]
		reviewed("helpers.py", hunks)
		const first = JSON.parse(await call({ path: "helpers.py", edits: hunks }))
		expect(first.status).toBe("applied")
		const afterFirst = read()

		const second = JSON.parse(await call({ path: "helpers.py", edits: hunks }))
		expect(second.status).toBe("unreviewed")
		expect(read()).toBe(afterFirst)
	})

	test("a review tied to a denied tool call is dropped before it can be reused", async () => {
		const hunks = [{ oldText: 'return val not in ("0", "false", "no")', newText: "return bool(val)" }]
		recordHunkDecisions(proposalKey("helpers.py", hunks), [true], "call-denied")
		clearHunkDecisionForToolCall("call-denied")
		const result = JSON.parse(await call({ path: "helpers.py", edits: hunks }))
		expect(result.status).toBe("unreviewed")
		expect(read()).toBe(ORIGINAL)
	})

	test("a review whose length does not match the proposal is not consent", async () => {
		const hunks = [
			{ oldText: 'return val not in ("0", "false", "no")', newText: "return bool(val)" },
			{ oldText: "def get_debug_flag():", newText: "def get_debug_flag() -> bool:" },
		]
		recordHunkDecisions(proposalKey("helpers.py", hunks), [true])
		const result = JSON.parse(await call({ path: "helpers.py", edits: hunks }))
		expect(result.status).toBe("unreviewed")
		expect(read()).toBe(ORIGINAL)
	})
})

describe("stale bases and overlapping hunks", () => {
	test("a proposal built from a stale base writes nothing", async () => {
		const firstHunks = [{ oldText: "def get_debug_flag():", newText: "def get_debug_flag() -> bool:" }]
		reviewed("helpers.py", firstHunks)
		expect(JSON.parse(await call({ path: "helpers.py", edits: firstHunks })).status).toBe("applied")
		const afterFirst = read()

		// Second proposal was built from the original base and targets the line the first
		// edit already replaced, so its anchor no longer exists.
		const staleHunks = [{ oldText: "def get_debug_flag():", newText: "def get_debug_flag() -> bool:  # again" }]
		reviewed("helpers.py", staleHunks)
		const stale = JSON.parse(await call({ path: "helpers.py", edits: staleHunks }))
		expect(stale.status).toBe("rejected")
		expect(stale.applied).toBe(0)
		expect(read()).toBe(afterFirst)
	})

	test("a file edited after review keeps the newer bytes when the hunk no longer matches", async () => {
		const hunks = [{ oldText: 'return val not in ("0", "false", "no")', newText: "return bool(val)" }]
		reviewed("helpers.py", hunks)
		const userEdit = ORIGINAL.replace('return val not in ("0", "false", "no")', 'return val not in ("0",)  # user edit')
		writeFileSync(join(root, "helpers.py"), userEdit, "utf8")

		const result = JSON.parse(await call({ path: "helpers.py", edits: hunks }))
		expect(result.status).toBe("rejected")
		expect(read()).toBe(userEdit)
	})

	test("overlapping hunks apply at most once and never corrupt the file", async () => {
		const hunks = [
			{
				oldText: '    val = os.environ.get("FLASK_DEBUG")\n    return val',
				newText: '    val = os.environ.get("FLASK_DEBUG")\n    return bool(val',
			},
			{ oldText: '    return val not in ("0", "false", "no")', newText: "return True" },
		]
		reviewed("helpers.py", hunks)
		const result = JSON.parse(await call({ path: "helpers.py", edits: hunks }))
		expect(result.status).toBe("applied")
		expect(result.hunks).toBeGreaterThanOrEqual(1)
		expect(result.rejected.length).toBeGreaterThanOrEqual(0)
		const body = read()
		// The second hunk's base text was consumed by the first; it must not be re-applied.
		expect(body).not.toContain("return True")
		expect(body).toContain("bool(val")
	})

	test("a partial multi-file change keeps the failed file untouched", async () => {
		writeFileSync(join(root, "other.py"), "VALUE = 1\n", "utf8")
		const okHunks = [{ oldText: "VALUE = 1", newText: "VALUE = 2" }]
		reviewed("other.py", okHunks)
		expect(JSON.parse(await call({ path: "other.py", edits: okHunks })).status).toBe("applied")

		const staleHunks = [{ oldText: "HELLO = 1", newText: "HELLO = 2" }]
		reviewed("missing.py", staleHunks)
		writeFileSync(join(root, "missing.py"), "HELLO = 99\n", "utf8")
		const stale = JSON.parse(await call({ path: "missing.py", edits: staleHunks }))
		expect(stale.status).toBe("rejected")
		expect(readFileSync(join(root, "missing.py"), "utf8")).toBe("HELLO = 99\n")
		expect(readFileSync(join(root, "other.py"), "utf8")).toBe("VALUE = 2\n")
	})
})

describe("undo safety", () => {
	test("undo refuses to overwrite an unrelated later edit", async () => {
		const hunks = [{ oldText: 'return val not in ("0", "false", "no")', newText: "return bool(val)" }]
		reviewed("helpers.py", hunks)
		expect(JSON.parse(await call({ path: "helpers.py", edits: hunks })).status).toBe("applied")

		const later = `${read()}\n# unrelated later edit\n`
		writeFileSync(join(root, "helpers.py"), later, "utf8")
		const undo = JSON.parse(await callEditorTool("editor_undo_last_edit", {}, ctx()))
		expect(undo.status).toBe("stale")
		expect(read()).toBe(later)
	})

	test("undo restores exact bytes when nothing else changed", async () => {
		const hunks = [{ oldText: 'return val not in ("0", "false", "no")', newText: "return bool(val)" }]
		reviewed("helpers.py", hunks)
		expect(JSON.parse(await call({ path: "helpers.py", edits: hunks })).status).toBe("applied")
		const undo = JSON.parse(await callEditorTool("editor_undo_last_edit", {}, ctx()))
		expect(undo.status).toBe("undone")
		expect(read()).toBe(ORIGINAL)
	})
})

describe("malformed proposals", () => {
	test("missing edits are refused without touching the file", async () => {
		await expect(call({ path: "helpers.py" })).rejects.toThrow(/at least one edit hunk/)
		expect(read()).toBe(ORIGINAL)
	})

	test("hunks without oldText/newText are refused", async () => {
		await expect(call({ path: "helpers.py", edits: [{ oldText: "x" }] })).rejects.toThrow(/oldText and newText/)
		expect(read()).toBe(ORIGINAL)
	})

	test("a path outside the workspace is refused", async () => {
		await expect(call({ path: "../../etc/hosts", edits: [{ oldText: "a", newText: "b" }] })).rejects.toThrow(
			/escapes workspace/,
		)
	})

	test("an empty path is refused", async () => {
		await expect(call({ path: "  ", edits: [{ oldText: "a", newText: "b" }] })).rejects.toThrow(/non-empty `path`/)
	})
})
