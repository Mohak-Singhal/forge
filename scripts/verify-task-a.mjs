/**
 * Task A gate — the real editor write path against the pinned flask checkout.
 *
 * This drives the same MCP tool the agent calls (`editor_propose_edit`) and the same
 * fail-closed review registry the editor fills in. It proves the *tool layer*:
 *   1. an unreviewed proposal writes nothing;
 *   2. a reviewed proposal applies exactly the accepted hunks;
 *   3. `FLASK_DEBUG` accepts off/n case-insensitively;
 *   4. undo restores byte-identical content.
 *
 * It does not open a VS Code window; the diff tab and per-hunk dialog are the UI layer
 * above this contract (ForgeHunkReview.ts), covered by unit tests.
 *
 * Requires: flask demo repo at tag 3.1.3, clean working tree, .venv present.
 * Run: bun run scripts/verify-task-a.mjs
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { callEditorTool } from "../apps/vscode/src/trueforge/mcp/tools.ts"
import { proposalKey, recordHunkDecisions } from "../apps/vscode/src/trueforge/hunk-review.ts"

const ROOT = process.env.FLASK_REPO ?? "/Users/mohaksinghal/Documents/GitHub/forge-demo/flask"
const REL = "src/flask/helpers.py"
const ABS = `${ROOT}/${REL}`

function fail(message) {
	console.error(`TASK_A_FAIL ${message}`)
	process.exit(1)
}

const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT, encoding: "utf8" }).trim()
if (dirty) fail(`flask working tree is not clean:\n${dirty}`)

const before = readFileSync(ABS, "utf8")
const hunks = [
	{
		oldText: '    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no"})',
		newText:
			'    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})',
		intent: "treat off and n as false",
	},
	{
		oldText:
			'    """Get whether debug mode should be enabled for the app, indicated by the\n    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.\n    """',
		newText:
			'    """Get whether debug mode should be enabled for the app, indicated by the\n    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.\n\n    The values ``0``, ``false``, ``no``, ``off`` and ``n`` (case-insensitive) are\n    treated as false.\n    """',
		intent: "document every false value",
	},
]

// 1. No review → refuse, file untouched.
const refused = JSON.parse(
	await callEditorTool("editor_propose_edit", { path: REL, summary: "Task A", edits: hunks }, { root: ROOT }),
)
if (refused.status !== "unreviewed") fail(`expected unreviewed, got ${refused.status}`)
if (readFileSync(ABS, "utf8") !== before) fail("an unreviewed proposal modified the file")

// 2. Reviewed → apply only accepted hunks.
recordHunkDecisions(proposalKey(REL, hunks), [true, true])
const applied = JSON.parse(
	await callEditorTool("editor_propose_edit", { path: REL, summary: "Task A", edits: hunks }, { root: ROOT }),
)
if (applied.status !== "applied" || applied.hunks !== 2) fail(`expected 2 applied hunks, got ${JSON.stringify(applied)}`)

// 3. Behaviour of the edited function.
const run = (value) =>
	execFileSync(".venv/bin/python", ["-c", "from flask.helpers import get_debug_flag; print(get_debug_flag())"], {
		cwd: ROOT,
		env: { ...process.env, FLASK_DEBUG: value },
		encoding: "utf8",
	}).trim()
const expected = { off: "False", n: "False", OFF: "False", N: "False", "0": "False", "false": "False", no: "False", "1": "True", yes: "True" }
for (const [value, want] of Object.entries(expected)) {
	const got = run(value)
	if (got !== want) fail(`FLASK_DEBUG=${value} printed ${got}, expected ${want}`)
}

// 4. Undo restores exact bytes.
const undone = JSON.parse(
	await callEditorTool("editor_undo_last_edit", { proposalId: applied.proposalId }, { root: ROOT }),
)
if (undone.status !== "undone") fail(`undo failed: ${JSON.stringify(undone)}`)
if (readFileSync(ABS, "utf8") !== before) fail("undo did not restore the original bytes")

console.log(`TASK_A_OK unreviewed-refused reviewed-applied=2 FLASK_DEBUG=${JSON.stringify(expected)} undo=byte-exact`)
