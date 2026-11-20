// G5: loopback MCP server lists the editor tools.
const res = await fetch("http://127.0.0.1:8791/mcp", {
	method: "POST",
	headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
	body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
	signal: AbortSignal.timeout(8000),
})
const text = await res.text()
const dataLine = text.split("\n").find((l) => l.startsWith("data: "))
const tools = JSON.parse(dataLine.slice(6)).result.tools.map((t) => t.name)
const need = ["editor_read_file", "editor_search", "editor_repo_map", "editor_retrieve", "editor_diagnostics", "editor_propose_edit", "editor_run_command"]
const missing = need.filter((n) => !tools.includes(n))
if (res.ok && missing.length === 0) {
	console.log("MCP_TOOLS_OK", tools.join(","))
	process.exit(0)
}
console.error(`FAIL status=${res.status} missing=${missing.join(",")}`)
process.exit(1)
