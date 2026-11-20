// G4: the extension compiles/builds cleanly from this repo.
// Runs the real production build (check-types + lint + webview + esbuild) and asserts
// the bundle it is supposed to produce actually exists and is non-trivial in size.
import { execSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"

const root = process.cwd()
const vscodeDir = join(root, "apps", "vscode")

function run(label, command, cwd) {
	process.stdout.write(`\n=== ${label} ===\n`)
	try {
		execSync(command, { cwd, stdio: "inherit", env: { ...process.env, CI: "1" } })
		return true
	} catch (error) {
		console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
		return false
	}
}

if (!run("build:sdk", "bun run build:sdk", root)) {
	process.exit(1)
}
if (!run("package (check-types + lint + production build)", "bun run package", vscodeDir)) {
	process.exit(1)
}

const bundle = join(vscodeDir, "dist", "extension.js")
const webview = join(vscodeDir, "webview-ui", "build", "index.html")
const problems = []
if (!existsSync(bundle)) {
	problems.push(`missing ${bundle}`)
} else if (statSync(bundle).size < 100_000) {
	problems.push(`suspiciously small bundle: ${statSync(bundle).size} bytes`)
}
if (!existsSync(webview)) {
	problems.push(`missing ${webview}`)
}

if (problems.length) {
	console.error(`FAIL ${problems.join("; ")}`)
	process.exit(1)
}
console.log(`BUILD_OK extension.js=${statSync(bundle).size}B webview=ok`)
