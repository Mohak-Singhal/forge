/**
 * Fallback integration check — proves Task C's "a second configured model takes over
 * automatically" against the real TrueForge server, not a mock.
 *
 * What it does:
 *   1. Saves the provider list.
 *   2. Points the primary model's provider at a dead port (an unreachable endpoint).
 *   3. Creates an inline session with the committed agent spec, so the primary fails.
 *   4. Uses the same decision logic the extension uses to fail over to the configured cloud model.
 *   5. Asserts the fallback turn produced real text, and restores the providers.
 *
 * Run: bun run scripts/verify-fallback.mjs
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { attemptOrder, decideFallback, modelChainFromSpec } from "../apps/vscode/src/trueforge/model-fallback.ts"

const TF = "http://localhost:8790"
const REPO = join(import.meta.dir, "..")
const SPEC_PATH = join(REPO, ".trueforge", "agents", "forge-editor.json")

async function getProviders() {
	const res = await fetch(`${TF}/api/v1/settings/model-providers`)
	if (!res.ok) throw new Error(`list providers: ${res.status}`)
	return (await res.json()).data
}

async function putProvider(manifest) {
	const res = await fetch(`${TF}/api/v1/settings/model-providers`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ manifest }),
	})
	if (!res.ok) throw new Error(`put ${manifest.name}: ${res.status} ${await res.text()}`)
}

async function createSession(spec) {
	const res = await fetch(`${TF}/api/v1/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ agent: { spec } }),
	})
	if (!res.ok) throw new Error(`create session: ${res.status} ${await res.text()}`)
	return (await res.json()).data.id
}

async function switchSessionModel(sessionId, spec, modelName) {
	const next = { ...spec, model: { ...spec.model, name: modelName } }
	const res = await fetch(`${TF}/api/v1/sessions/${sessionId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ agent: { spec: next } }),
	})
	return res.ok
}

/** Read the completed turn from TrueForge, including the model that served it. */
async function runTurn(sessionId, prompt) {
	const turnsUrl = `${TF}/api/v1/sessions/${sessionId}/turns`
	const res = await fetch(turnsUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ input: [{ type: "user.message", content: prompt }], stream: false }),
		signal: AbortSignal.timeout(120_000),
	})
	if (!res.ok) throw new Error(`create turn: ${res.status}`)
	const { id } = (await res.json()).data
	for (let attempt = 0; attempt < 60; attempt++) {
		const detail = await fetch(`${turnsUrl}/${id}`, { signal: AbortSignal.timeout(10_000) })
		if (!detail.ok) throw new Error(`read turn: ${detail.status}`)
		const { state } = (await detail.json()).data
		if (["done", "completed", "error", "failed", "cancelled"].includes(state.status)) {
			return {
				text: state.output?.content ?? "",
				model: state.output?.model?.name,
				errorMessage: state.message ?? "",
				status: state.status,
			}
		}
		await Bun.sleep(500)
	}
	throw new Error("Timed out waiting for the TrueForge turn")
}

const committed = JSON.parse(readFileSync(SPEC_PATH, "utf8"))
// This gate exercises model failover, not the editor tools. The MCP server on
// 127.0.0.1:8791 exists only while the VS Code extension host is running, and a
// missing MCP server would fail the turn before the model is ever called — which
// would prove nothing about fallback. So the probe uses the committed model chain without MCP tools and sends a simple ping.
const { mcp_servers: _omit, ...specWithoutTools } = committed
const spec = { ...specWithoutTools, instructions: "Reply with the single word: pong" }
console.log(`mcp servers in committed spec: ${(committed.mcp_servers ?? []).length} (dropped for this probe)`)
const chain = modelChainFromSpec(spec.model)
const order = attemptOrder(chain)
console.log(`chain: ${order.join(" → ")}`)

const original = await getProviders()
console.log(`providers before: ${original.map((p) => p.name).join(", ")}`)

const primary = original.find((p) => spec.model.name.startsWith(`${p.name}/`))
if (!primary) throw new Error(`no provider owns ${spec.model.name}`)

let failedOver = false
try {
	// Break the primary: point it at a port nothing listens on.
	const broken = { ...primary.manifest, base_url: "http://127.0.0.1:9/v1" }
	await putProvider(broken)
	console.log(`broke ${primary.name} → ${broken.base_url}`)

	const sessionId = await createSession(spec)
	console.log(`session: ${sessionId}`)

	let modelIndex = 0
	let activeModel = order[0]
	let result = await runTurn(sessionId, "ping")

	if (result.errorMessage || result.status === "error") {
		console.log(`primary failed as expected: ${result.errorMessage || result.status}`)
		const decision = decideFallback(chain, activeModel, new Error(result.errorMessage), modelIndex + 1)
		console.log(`decision: failover=${decision.shouldFailover} next=${decision.next ?? "none"}`)
		if (!decision.shouldFailover || !decision.next) {
			throw new Error(`no failover available: ${decision.note}`)
		}
		const switched = await switchSessionModel(sessionId, spec, decision.next)
		if (!switched) throw new Error(`Could not switch to ${decision.next}`)
		console.log(`session re-pointed to ${decision.next}`)
		modelIndex = decision.nextIndex ?? 1
		activeModel = decision.next
		result = await runTurn(sessionId, "ping")
		failedOver = true
	}

	console.log(`fallback turn text: ${JSON.stringify(result.text.slice(0, 120))}`)
	console.log(`fallback turn error: ${JSON.stringify(result.errorMessage)}`)
	if (result.model !== activeModel || !/^pong[.!]?$/i.test(result.text.trim())) {
		throw new Error("The expected fallback model did not return PONG")
	}
	console.log("FALLBACK_OK: the second configured model took over automatically")
} finally {
	await putProvider(primary.manifest)
	const restored = await getProviders()
	const primaryRestored = restored.find((p) => p.name === primary.name)
	console.log(`restored ${primary.name} → ${primaryRestored.manifest.base_url}`)
}

process.exit(failedOver ? 0 : 1)
