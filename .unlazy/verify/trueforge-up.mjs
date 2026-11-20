// G2: TrueForge local server answers.
const res = await fetch("http://localhost:8790/api/v1/settings/model-providers", { signal: AbortSignal.timeout(5000) })
if (res.ok) {
	console.log("TRUEFORGE_UP")
	process.exit(0)
}
console.error(`FAIL status=${res.status}`)
process.exit(1)
