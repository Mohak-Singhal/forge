// G1: fork declaration + upstream LICENSE preserved.
import { execSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
const root = process.cwd()
const FORK = "eff43e19b267e171f597ab03733bfed25090f72d"
const branch = execSync("git rev-parse --abbrev-ref HEAD").toString().trim()
const merge = execSync(`git merge-base --is-ancestor ${FORK} ${branch} && echo ANCESTOR_OK`).toString().trim()
const license = readFileSync(`${root}/LICENSE`, "utf8")
const apache = license.includes("Apache License")
const readme = readFileSync(`${root}/README.md`, "utf8")
const declared = readme.includes(FORK)
if (merge === "ANCESTOR_OK" && apache && declared) {
	console.log("FORK_POINT_OK")
	process.exit(0)
}
console.error(`FAIL merge=${merge} apache=${apache} declared=${declared}`)
process.exit(1)
