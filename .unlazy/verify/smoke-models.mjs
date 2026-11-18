// G3: two OpenAI-compatible models are configured in TrueForge and both answer a smoke turn.
//
// "Configured" is read from the live TrueForge settings API, not a file, so this gate
// fails if the running server lost its providers. "Answer" is a real turn through the
// same HTTP API the extension uses, so a model that is listed but unusable (bad key,
// dead endpoint) fails here instead of during the demo.
const BASE = (process.env.TRUEFORGE_URL ?? "http://localhost:8790").replace(/\/$/, "")
const PROMPT = "ping"
const EXPECT = "pong"

async function json(path, init, timeoutMs = 30_000) {
	const res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
	const text = await res.text()
	if (!res.ok) {
		throw new Error(`${path} -> ${res.status}: ${text.slice(0, 300)}`)
	}
	try {
		return JSON.parse(text)
	} catch {
		throw new Error(`${path} returned non-JSON: ${text.slice(0, 200)}`)
	}
}

// 1. Which models does the running TrueForge actually have?
let providers
try {
	providers = await json("/api/v1/settings/model-providers")
} catch (error) {
	console.error(`FAIL cannot read providers: ${error.message}`)
	process.exit(1)
}

const models = []
for (const provider of providers.data ?? []) {
	const manifest = provider.manifest ?? provider
	const providerName = manifest.name ?? provider.name
	for (const model of manifest.models ?? []) {
		const alias = model.name ?? model.model_id
		models.push({ provider: providerName, model: model.model_id, alias, full: `${providerName}/${alias}` })
	}
}

if (models.length < 2) {
	console.error(`FAIL only ${models.length} model(s) configured; need at least 2`)
	process.exit(1)
}
console.log(`configured (${models.length}): ${models.map((m) => m.full).join(", ")}`)

// 2. Each model answers a real turn through TrueForge.
const results = []
for (const entry of models) {
	const label = entry.full
	try {
		const created = await json("/api/v1/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: { spec: { instructions: `Reply with the single word: ${EXPECT}`, model: { name: label } } },
			}),
		})
		const sessionId = created.data?.id
		if (!sessionId) {
			throw new Error("session create returned no id")
		}

		const turn = await json(
			`/api/v1/sessions/${sessionId}/turns`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ input: [{ type: "user.message", content: PROMPT }], stream: false }),
			},
			120_000,
		)
		const turnId = turn.data?.id
		if (!turnId) {
			throw new Error("turn create returned no id")
		}

		// Poll until the turn leaves "running".
		let status = "running"
		let reply = ""
		let detail
		for (let attempt = 0; attempt < 120; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 1000))
			detail = await json(`/api/v1/sessions/${sessionId}/turns/${turnId}`)
			const data = detail.data ?? detail
			status = String(data.state?.status ?? "")
			reply = String(data.state?.output?.content ?? "")
			if (["done", "completed", "failed", "error", "cancelled"].includes(status)) {
				break
			}
		}

		const ok = ["done", "completed"].includes(status) && reply.trim().length > 0
		results.push({ label, ok, status, reply })
		console.log(`${ok ? "OK  " : "FAIL"} ${label} status=${status} reply="${reply.trim().slice(0, 40)}"`)
	} catch (error) {
		results.push({ label, ok: false, status: "error", reply: String(error.message ?? error) })
		console.log(`FAIL ${label}: ${error.message ?? error}`)
	}
}

const failed = results.filter((r) => !r.ok)
if (failed.length) {
	console.error(`FAIL ${failed.length}/${results.length} model(s) did not answer`)
	process.exit(1)
}
console.log(`SMOKE_OK ${results.length} models answered`)
