// G9: no real secrets anywhere in HEAD, and the fork delta is clean.
import { execSync } from "node:child_process"
const FORK = "eff43e19b267e171f597ab03733bfed25090f72d"
const bad = []
// Tree-wide high-confidence secret patterns (fixtures already carry gitleaks:allow upstream)
const treeHits = (() => {
	try {
		return execSync(
			`git grep -n -E "sk_live_[0-9A-Za-z]{10,}|sk-live-[0-9A-Za-z]{20,}|AIza[0-9A-Za-z_-]{30,}|ghp_[0-9A-Za-z]{30,}|xox[baprs]-[0-9]+-[0-9A-Za-z-]{10,}|hms-[0-9a-f]{6,}-[0-9a-f]{6,}-[0-9a-f]{6,}" HEAD -- .`
		).toString()
	} catch { return "" }
})()
for (const line of treeHits.split("\n").filter(Boolean)) {
	if (!/gitleaks:allow|SECRET|1234/.test(line)) bad.push(line)
}
// Private key blocks outside designated test fixtures
const keyHits = (() => {
	try {
		return execSync(
			`git grep -n -E "BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY" HEAD -- .`
		).toString()
	} catch { return "" }
})()
for (const line of keyHits.split("\n").filter(Boolean)) {
	if (!/(ca-certs\.test\.ts|gitleaks:allow|fixture)/i.test(line)) bad.push(line)
}
// Delta files get the strictest pass
const delta = execSync(`git diff --name-only ${FORK}..HEAD`).toString().trim().split("\n").filter(Boolean)
for (const file of delta) {
	let text = ""
	try { text = execSync(`git show HEAD:"${file}"`, { maxBuffer: 32 * 1024 * 1024 }).toString() } catch { continue }
	for (const pat of [/sk-[A-Za-z0-9]{16,}/, /api_key["']?\s*[:=]\s*["'][A-Za-z0-9_-]{16,}/, /api_key["']?\s*[:=]\s*"(?!hms-|env-|example|ENV:)[A-Za-z0-9]{10,}/, /Bearer [A-Za-z0-9_-]{30,}/]) {
		if (pat.test(text)) bad.push(`${file}: ${pat}`)
	}
}
if (bad.length === 0) {
	console.log("HYGIENE_OK")
	process.exit(0)
}
console.error(`FAIL potential secrets:\n${bad.slice(0, 20).join("\n")}`)
process.exit(1)
