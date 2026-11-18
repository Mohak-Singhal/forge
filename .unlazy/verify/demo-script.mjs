// G10: the demo script walks Tasks A, B and C with the exact verification commands.
// This checks the script's content, not the video (recording is out of scope until the
// user asks for it).
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const file = join(process.cwd(), "report", "demo-script.md")
if (!existsSync(file)) {
	console.error(`FAIL missing ${file}`)
	process.exit(1)
}
const text = readFileSync(file, "utf8")
const checks = [
	["Task A shot", /## Shot 1 — Task A/],
	["Task B shot", /## Shot 2 — Task B/],
	["Task C shot", /## Shot 3 — Task C/],
	["Task A verification command", /FLASK_DEBUG=off[^\n]*get_debug_flag/],
	["Task B exact instruction", /Add a new built-in CLI command flask config/],
	["pytest verification", /pytest tests\/test_cli\.py/],
	["flask --help verification", /flask --help/],
	["masked JSON verification", /mask|\*\*\*/i],
	["clean-tree verification", /git status/],
]
const problems = checks.filter(([, pattern]) => !pattern.test(text)).map(([label]) => label)
if (problems.length) {
	console.error(`FAIL demo script missing: ${problems.join(", ")}`)
	process.exit(1)
}
console.log(`DEMO_SCRIPT_OK ${checks.length} checks (A/B/C shots + verification commands)`)
