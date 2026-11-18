/**
 * Loopback MCP server exposing Forge editor tools to TrueForge.
 *
 * The TrueForge agent (forge-editor) is configured in .trueforge/agents/forge-editor.json
 * with a `vscode-editor-tools` connector pointing at http://127.0.0.1:8791/mcp. This server
 * runs inside the extension host and gives the agent the capabilities the rules require:
 * read a file, search the workspace, propose a write, run a command.
 *
 * Writes are staged (editor_propose_edit) and only applied after the user approves the
 * diff in the Cline UI — approval flow lives in the approval button in chat
 * (handleRequestToolApproval) which TF pauses for when require_approval_for_tools matches.
 */

import { randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { WorkspaceContext } from "./tools"
import { callEditorTool } from "./tools"
import { Logger } from "@shared/services/Logger"

export interface ForgeMcpServerOptions {
	port?: number
}

export class ForgeMcpServer {
	private readonly port: number
	private readonly token: string
	private server: Server | undefined
	private ctx: WorkspaceContext | undefined

	constructor(options: ForgeMcpServerOptions = {}) {
		this.port = options.port ?? 8791
		this.token = process.env.FORGE_MCP_TOKEN ?? randomBytes(16).toString("hex")
	}

	get authorizationToken(): string {
		return this.token
	}

	get endpointUrl(): string {
		return `http://127.0.0.1:${this.port}/mcp`
	}

	setWorkspaceRoot(root: string): void {
		this.ctx = { root }
	}

	get isRunning(): boolean {
		return !!this.server
	}

	async start(workspaceRoot: string): Promise<void> {
		if (this.server) {
			return
		}
		this.ctx = { root: workspaceRoot }

		const buildMcp = (): McpServer => {
			const mcp = new McpServer({ name: "vscode-editor-tools", version: "1.0.0" })
			const schema = this.buildSchemas()
			for (const [name, config] of Object.entries(schema)) {
				const toolName = name
				const shape = config.shape as z.ZodRawShape
				const description = config.description
				mcp.registerTool(
					toolName,
					{
						description,
						...(Object.keys(shape).length > 0 ? { inputSchema: shape } : {}),
					},
					async (args) => {
						try {
							const result = await callEditorTool(toolName, (args ?? {}) as Record<string, unknown>, { root: this.ctx?.root ?? workspaceRoot })
							return { content: [{ type: "text" as const, text: result }] }
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error)
							return { content: [{ type: "text" as const, text: `error: ${message}` }], isError: true }
						}
					},
				)
			}
			return mcp
		}

		this.server = createServer((req, res) => {
			void (async () => {
				try {
					// Loopback-only dev endpoint: TF (same machine, same process) connects here.
					// Stateless per-request server: fresh McpServer + transport, like the SDK docs show.
					const mcp = buildMcp()
					const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
					await mcp.connect(transport)
					await transport.handleRequest(req, res)
				} catch (error) {
					Logger.error("[Forge] MCP stream error:", error)
					if (!res.headersSent) {
						res.writeHead(500, { "content-type": "application/json" })
					}
					res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }))
				}
			})()
		})

		await new Promise<void>((resolvePromise, reject) => {
			this.server?.once("error", reject)
			this.server?.listen(this.port, "127.0.0.1", () => resolvePromise())
		})
	}

	async stop(): Promise<void> {
		const server = this.server
		this.server = undefined
		if (!server) {
			return
		}
		await new Promise<void>((resolvePromise, reject) => {
			server.close((error) => (error ? reject(error) : resolvePromise()))
		})
	}

	private buildSchemas(): Record<
		string,
		{ description: string; shape: z.ZodRawShape | Record<string, never> }
	> {
		const str = () => z.string()
		return {
			editor_read_file: {
				description: "Read a workspace file (relative or absolute path) with optional 1-based line range.",
				shape: { path: str(), start_line: z.number().optional(), end_line: z.number().optional() },
			},
			editor_search: {
				description: "Regex-search the workspace. Returns path:line: text matches.",
				shape: { pattern: str(), path: str().optional(), limit: z.number().optional() },
			},
			editor_repo_map: {
				description: "Compact map of the repository (paths + def/class signatures) to orient before editing.",
				shape: {},
			},
			editor_retrieve: {
				description: "Retrieve the most relevant code chunks for a natural-language query (BM25). Use this before editing.",
				shape: { query: str(), limit: z.number().optional() },
			},
			editor_run_command: {
				description: "Run a shell command in the workspace root. Destructive/network commands (rm -rf, git push, sudo, curl) are refused. 60s timeout.",
				shape: { command: str() },
			},
			editor_propose_edit: {
				description:
					"Stage a multi-file edit as reviewable hunks. Nothing is written until the user approves the diff and applies it — this tool only computes and stages. Input: {path, summary, edits: [{oldText, newText, intent?}]}.",
				shape: {
					path: str(),
					summary: str().optional(),
					edits: z.array(z.object({ oldText: str(), newText: str(), intent: str().optional() })),
				},
			},
			editor_diagnostics: {
				description: "Fast syntax check for the workspace's Python files (py_compile). Use before and after edits.",
				shape: { path: str().optional() },
			},
		}
	}
}

export const forgeMcpServer = new ForgeMcpServer()
