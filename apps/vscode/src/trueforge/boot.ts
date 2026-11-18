/**
 * Forge engine boot — called from extension activate().
 *
 * 1. Starts the loopback MCP server exposing the editor tools to the TF agent.
 * 2. Refreshes the TF `vscode-editor-tools` connector so TF can call the tools
 *    (best-effort: TF may be down; the agent then surfaces a clear error, which is
 *    exactly the failure mode Task C exercises).
 * 3. Points the MCP server at the workspace root.
 */

import { randomBytes } from "node:crypto"
import * as vscode from "vscode"
import { forgeMcpServer } from "./mcp/server"
import { TrueForgeClient } from "./client"
import { Logger } from "@/shared/services/Logger"

export interface ForgeBootOptions {
	workspaceRoot: string | undefined
}

export async function bootForge(context: vscode.ExtensionContext, options: ForgeBootOptions): Promise<void> {
	if (!options.workspaceRoot) {
		Logger.log("[Forge] no workspace folder — forge tools disabled")
		return
	}
	const token = process.env.FORGE_MCP_TOKEN ?? randomBytes(16).toString("hex")
	process.env.FORGE_MCP_TOKEN = token
	try {
		await forgeMcpServer.start(options.workspaceRoot)
	} catch (error) {
		Logger.error("[Forge] MCP server failed to start:", error)
		return
	}
	context.subscriptions.push({ dispose: () => void forgeMcpServer.stop() })
	Logger.log(`[Forge] editor tools MCP server listening on 127.0.0.1:8791 (workspace: ${options.workspaceRoot})`)

	// Best-effort connector upsert; don't fail activation if TF isn't running.
	try {
		const client = new TrueForgeClient(process.env.TRUEFORGE_URL ?? "http://localhost:8790")
		await client.raw.settings.mcpServers.createOrUpdate({
			manifest: {
				name: "vscode-editor-tools",
				type: "remote",
				url: "http://127.0.0.1:8791/mcp",
				description: "Forge editor tools: read_file, search, retrieve, repo_map, run_command, propose_edit, diagnostics",
				auth: { type: "header", headers: { "x-forge-token": token } },
			},
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any)
		Logger.log("[Forge] vscode-editor-tools connector upserted in TrueForge")
	} catch (error) {
		Logger.warn("[Forge] could not upsert TF connector (TF down?):", error instanceof Error ? error.message : String(error))
	}
}
