/**
 * TrueForgeSessionHost — an SdkSessionHost backed by the local TrueForge server
 * (npx @truefoundry/trueforge@latest) instead of Cline Core's in-process loop.
 *
 * The host creates a TrueForge session, feeds user turns to its SSE stream, and
 * re-emits every turn event as the `CoreSessionEvent` shapes the rest of the
 * extension (message-translator, SdkController, webview) already understands.
 * Editor capabilities run as MCP tools via the loopback server in ./mcp/server.ts.
 *
 * Approvals: TF pauses the turn with `tool.approval_required` when a tool is listed
 * under `require_approval_for_tools` in the agent definition. This host maps that
 * pause to the exact same `requestToolApproval` callback Cline uses for its own
 * tools, so the webview renders Approve/Reject, then forwards the answer to TF as a
 * `user.tool_approval` event. Nothing touches disk before the user clicks Approve.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
	type CompareCheckpointResult,
	type CoreSessionEvent,
	type HookEventPayload,
	type PendingPromptMutationResult,
	type PendingPromptsDeleteInput,
	type PendingPromptsListInput,
	type PendingPromptsUpdateInput,
	type RestoreInput,
	type RestoreResult,
	type SendSessionInput,
	type SessionAccumulatedUsage,
	type SessionCompactionState,
	type SessionHistoryRecord,
	type SessionPendingPrompt,
	type SessionRecord,
	type StartSessionInput,
	type StartSessionResult,
} from "@cline/core"
import type { AgentResult } from "@cline/shared"
import { Logger } from "@shared/services/Logger"
import type { AgentIterationStartEvent, AgentContentStartEvent, AgentContentEndEvent, AgentDoneEvent, AgentErrorEvent, AgentEvent } from "@cline/shared"
import type { AgentUsageEvent as TFAgentUsageEvent } from "@cline/shared"
import type { SdkInitialMessages, SdkSessionHost } from "../sdk/session-host"
import { TrueForgeClient, type ForgeAgentSpec } from "./client"

function loadForgeAgentSpec(extensionPath: string): ForgeAgentSpec {
	// Agent definition is committed by the fork: .trueforge/agents/forge-editor.json
	const candidates = [
		join(extensionPath, ".trueforge", "agents", "forge-editor.json"),
		join(process.cwd(), ".trueforge", "agents", "forge-editor.json"),
		join(extensionPath, "..", "..", ".trueforge", "agents", "forge-editor.json"),
	]
	for (const candidate of candidates) {
		try {
			const raw = readFileSync(candidate, "utf8")
			const parsed = JSON.parse(raw) as ForgeAgentSpec
			if (parsed && parsed.model?.name && parsed.instructions) {
				return parsed
			}
		} catch {
			// try next
		}
	}
	// Built-in fallback so the engine can never hard-fail to start.
	return {
		model: { name: process.env.FORGE_MODEL || "opencode-free-models/deepseek-v41-flash-free" },
		instructions:
			"You are Forge, the coding agent embedded in this editor. Read code with the editor tools, propose exact-hunk edits, and work to completion. editor_propose_edit and editor_run_command require user approval.",
		config: {},
	}
}

export interface TrueForgeSessionHostOptions {
	extensionPath: string
	trueforgeUrl?: string
	requestToolApproval?: (request: {
		toolCallId: string
		toolName: string
		input: unknown
		iteration?: number
		agentId: string
		conversationId: string
		policy: { enabled: boolean; autoApprove: boolean }
	}) => Promise<{ approved: boolean; reason?: string }>
	askQuestion?: (question: string, options: string[], _context: unknown) => Promise<{ text: string }>
}

interface TurnState {
	turnId?: string
	threadId?: string
	startedAt: string
	iteration: number
	contentAccumulator: { id?: string; text: string; toolCalls: Map<string, { name: string; arguments: string; id: string }> }
	usage: { inputTokens: number; outputTokens: number; cost: number }
	finished: boolean
}

function nowIso(): string {
	return new Date().toISOString()
}

function stageEvent(sessionId: string, event: AgentEvent): CoreSessionEvent {
	return { type: "agent_event", payload: { sessionId, event } } as CoreSessionEvent
}

export class TrueForgeSessionHost implements SdkSessionHost {
	readonly runtimeAddress: string | undefined
	private readonly url: string
	private readonly extensionPath: string
	private readonly client: TrueForgeClient
	private readonly requestToolApproval?: TrueForgeSessionHostOptions["requestToolApproval"]
	private readonly listeners = new Set<(event: CoreSessionEvent) => void>()
	/** sessionId (=TF session id) */
	private readonly sessions = new Map<string, { turn?: TurnState; createdAt: string; cwd: string; prompt: string }>()

	private constructor(options: TrueForgeSessionHostOptions) {
		this.url = (options.trueforgeUrl ?? process.env.TRUEFORGE_URL ?? "http://localhost:8790").replace(/\/$/, "")
		this.runtimeAddress = this.url
		this.extensionPath = options.extensionPath
		this.client = new TrueForgeClient(this.url)
		this.requestToolApproval = options.requestToolApproval
	}

	static async create(options: TrueForgeSessionHostOptions): Promise<TrueForgeSessionHost> {
		return new TrueForgeSessionHost(options)
	}

	// ---- SdkSessionHost: sessions ----

	async start(input: StartSessionInput): Promise<StartSessionResult> {
		const spec = loadForgeAgentSpec(this.extensionPath)
		const sessionId = await this.client.createInlineSession(spec)
		const cwd = input?.config?.workspaceRoot ?? (input?.config as { cwd?: string })?.cwd ?? process.cwd()
		this.sessions.set(sessionId, {
			createdAt: nowIso(),
			cwd,
			prompt: "",
			turn: {
				startedAt: nowIso(),
				iteration: 0,
				contentAccumulator: { text: "", toolCalls: new Map() },
				usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
				finished: false,
			},
		})
		this.emit({
			type: "status",
			payload: { sessionId, status: "idle" },
		} as unknown as CoreSessionEvent)
		const manifest = {
			version: 1 as const,
			session_id: sessionId,
			source: "forge-trueforge",
			pid: process.pid,
			started_at: nowIso(),
			status: "running" as const,
			interactive: true,
			provider: "trueforge",
			model: spec.model.name ?? "opencode-free-models/deepseek-v41-flash-free",
			cwd,
			workspace_root: cwd,
			enable_tools: true,
			enable_spawn: true,
			enable_teams: false,
			prompt: "",
		}
		return {
			sessionId,
			manifest,
			manifestPath: `trueforge://${sessionId}/manifest`,
			messagesPath: `trueforge://${sessionId}/messages`,
			result: undefined,
		}
	}

	async restore(_input: RestoreInput): Promise<RestoreResult> {
		throw new Error("TrueForge sessions cannot be restored (no checkpoint restore in local mode); start a fresh task instead")
	}

	async send(input: SendSessionInput): Promise<AgentResult | undefined> {
		const sessionId = input.sessionId
		const state = this.sessions.get(sessionId)
		if (!state?.turn) {
			throw new Error(`TrueForge session not started: ${sessionId}`)
		}
		const turn = state.turn
		turn.iteration += 1
		turn.contentAccumulator = { text: "", toolCalls: new Map() }
		turn.usage = { inputTokens: 0, outputTokens: 0, cost: 0 }
		turn.finished = false
		state.prompt = input.prompt
		this.emit({
			type: "status",
			payload: { sessionId, status: "running" },
		} as unknown as CoreSessionEvent)
		this.emit(stageEvent(sessionId, { type: "iteration_start", iteration: turn.iteration, agentId: sessionId, conversationId: sessionId } as AgentIterationStartEvent))
		try {
			for await (const event of this.client.streamTurn(sessionId, input.prompt)) {
				this.handleTurnEvent(sessionId, event as Record<string, unknown>)
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			Logger.error(`[TrueForge] turn stream failed: ${message}`)
			this.emit(
				stageEvent(sessionId, {
					type: "error",
					error: new Error(message),
					recoverable: true,
					iteration: turn.iteration,
					agentId: sessionId,
					conversationId: sessionId,
				} as AgentErrorEvent),
			)
			this.emit({ type: "ended", payload: { sessionId, reason: "error", ts: Date.now() } } as CoreSessionEvent)
			turn.finished = true
			return {
				text: `TrueForge error: ${message}`,
				usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 },
				messages: [],
				toolCalls: [],
				iterations: turn.iteration,
				finishReason: "error",
				model: { id: "trueforge-agent", provider: "trueforge" },
				startedAt: new Date(turn.startedAt),
				endedAt: new Date(),
				durationMs: 0,
			}
		}
		turn.finished = true
		return {
			text: turn.contentAccumulator.text,
			usage: {
				inputTokens: turn.usage.inputTokens,
				outputTokens: turn.usage.outputTokens,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalCost: turn.usage.cost,
			},
			messages: [],
			toolCalls: [],
			iterations: turn.iteration,
			finishReason: "completed",
			model: { id: "trueforge-agent", provider: "trueforge" },
			startedAt: new Date(turn.startedAt),
			endedAt: new Date(),
			durationMs: 0,
		}
	}

	// ---- Turn event mapping ----

	private handleTurnEvent(sessionId: string, event: Record<string, unknown>): void {
		const state = this.sessions.get(sessionId)
		const turn = state?.turn
		const type = typeof event.type === "string" ? (event.type as string) : ""
		switch (type) {
			case "turn.created": {
				if (turn) {
					turn.turnId = String(event.turnId ?? event.id ?? "")
				}
				break
			}
			case "turn.update":
			case "thread.created": {
				// Reserved for future interstitial updates; no UI message needed.
				break
			}
			case "model.message.delta": {
				const delta = event as unknown as {
					id?: string
					content?: string | null
					reasoningContent?: string | null
					toolCalls?: Array<Record<string, unknown>>
					usage?: { inputTokens?: number; outputTokens?: number }
				}
				if (delta.content) {
					if (turn) {
						turn.contentAccumulator.id = delta.id
						turn.contentAccumulator.text += delta.content
					}
					this.emit(
						stageEvent(sessionId, {
							type: "content_start",
							contentType: "text",
							text: delta.content,
							accumulated: turn?.contentAccumulator.text,
							agentId: sessionId,
							conversationId: sessionId,
						} as AgentContentStartEvent),
					)
				}
				if (delta.reasoningContent) {
					this.emit(
						stageEvent(sessionId, {
							type: "content_start",
							contentType: "reasoning",
							reasoning: delta.reasoningContent,
							firstSlate: true,
							agentId: sessionId,
							conversationId: sessionId,
						} as unknown as AgentContentStartEvent),
					)
				}
				for (const toolCall of delta.toolCalls ?? []) {
					this.trackToolCall(sessionId, toolCall)
				}
				if (delta.usage) {
					const usageEvent: TFAgentUsageEvent = {
						type: "usage",
						inputTokens: delta.usage.inputTokens ?? 0,
						outputTokens: delta.usage.outputTokens ?? 0,
						totalInputTokens: delta.usage.inputTokens ?? 0,
						totalOutputTokens: delta.usage.outputTokens ?? 0,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						cost: 0,
						totalCost: 0,
						agentId: sessionId,
						conversationId: sessionId,
					}
					this.emit(stageEvent(sessionId, usageEvent as AgentEvent))
				}
				return
			}
			case "model.message": {
				const msg = event as unknown as {
					content?: string | null | Array<Record<string, unknown>>
					reasoningContent?: string | null
					toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>
					usage?: { inputTokens?: number; outputTokens?: number }
				}
				const finalText = typeof msg.content === "string" ? msg.content : ""
				if (turn && finalText) {
					turn.contentAccumulator.text = finalText
					this.emit(
						stageEvent(sessionId, {
							type: "content_end",
							contentType: "text",
							text: finalText,
							agentId: sessionId,
							conversationId: sessionId,
						} as AgentContentEndEvent),
					)
				} else if (turn && turn.contentAccumulator.text) {
					this.emit(
						stageEvent(sessionId, {
							type: "content_end",
							contentType: "text",
							text: turn.contentAccumulator.text,
							agentId: sessionId,
							conversationId: sessionId,
						} as AgentContentEndEvent),
					)
				}
				for (const tc of msg.toolCalls ?? []) {
					this.trackToolCall(sessionId, tc as unknown as Record<string, unknown>)
					const fn = tc.function
					let input: unknown = {}
					try {
						input = JSON.parse(fn.arguments || "{}")
					} catch {
						input = { raw: fn.arguments }
					}
					this.emit(
						stageEvent(sessionId, {
							type: "content_start",
							contentType: "tool",
							toolName: fn.name,
							toolCallId: tc.id,
							input,
							agentId: sessionId,
							conversationId: sessionId,
							execution: "client",
						} as AgentContentStartEvent),
					)
				}
				if (msg.usage && turn) {
					turn.usage.inputTokens = msg.usage.inputTokens ?? turn.usage.inputTokens
					turn.usage.outputTokens = msg.usage.outputTokens ?? turn.usage.outputTokens
				}
				return
			}
			case "tool.response": {
				const res = event as unknown as { toolCallId?: string; content?: string }
				this.emit(
					stageEvent(sessionId, {
						type: "content_end",
						contentType: "tool",
						toolName: "vscode-editor-tools__tool",
						toolCallId: res.toolCallId,
						output: res.content ?? "",
						agentId: sessionId,
						conversationId: sessionId,
					} as AgentContentEndEvent),
				)
				return
			}
			case "tool.approval_required": {
				const approval = event as unknown as {
					id: string
					threadId: string
					toolCalls: Array<{ id: string; sourceEventId: string; toolName?: string; input?: unknown }>
				}
				this.handleToolApproval(sessionId, approval).catch((error) => {
					Logger.error("[TrueForge] approval flow failed:", error)
				})
				return
			}
			case "turn.done": {
				const done = event as unknown as { state?: { status?: string; code?: string; message?: string } }
				const stateKind = done.state?.status ?? "done"
				if (stateKind === "done" || stateKind === "cancelled" || stateKind === "failed") {
					const reason = stateKind === "done" ? "stop" : stateKind === "cancelled" ? "aborted" : "error"
					this.emit(
						stageEvent(sessionId, {
							type: "done",
							reason: reason as AgentDoneEvent["reason"],
							iterations: turn?.iteration ?? 1,
							text: turn?.contentAccumulator.text ?? "",
							agentId: sessionId,
							conversationId: sessionId,
						} as AgentDoneEvent),
					)
					this.emit({ type: "ended", payload: { sessionId, reason: reason === "error" ? "error" : "completed", ts: Date.now() } } as CoreSessionEvent)
					if (turn) {
						turn.finished = true
					}
				}
				return
			}
			case "error": {
				const err = event as unknown as { message?: string; code?: string }
				this.emit(
					stageEvent(sessionId, {
						type: "error",
						error: new Error(err.message ?? err.code ?? "TrueForge turn failed"),
						recoverable: true,
						iteration: turn?.iteration ?? 1,
						agentId: sessionId,
						conversationId: sessionId,
					} as AgentErrorEvent),
				)
				return
			}
			default: {
				// Unknown TF event: surface as a debug notice instead of crashing the turn.
				Logger.debug(`[TrueForge] Unhandled turn event type: ${type}`)
				return
			}
		}
	}

	private trackToolCall(sessionId: string, toolCall: Record<string, unknown>): void {
		const state = this.sessions.get(sessionId)
		if (!state?.turn) return
		const fn = toolCall.function as { name?: string; arguments?: string } | undefined
		const id = String(toolCall.id ?? "")
		if (!id) return
		state.turn.contentAccumulator.toolCalls.set(id, {
			id,
			name: fn?.name ?? "unknown",
			arguments: fn?.arguments ?? "",
		})
	}

	private async handleToolApproval(
		sessionId: string,
		approval: {
			id: string
			threadId: string
			toolCalls: Array<{ id: string; sourceEventId: string; toolName?: string; input?: unknown }>
		},
	): Promise<void> {
		const state = this.sessions.get(sessionId)
		const turnId = state?.turn?.turnId || ""
		// The webview's requestToolApproval shows the Approve/Reject ask. For MCP tools the
		// translator renders use_mcp_server; for propose_edit we map the toolName so the diff
		// preview opens via onToolApprovalAsk.
		for (const call of approval.toolCalls) {
			const tracked = state?.turn?.contentAccumulator.toolCalls.get(call.id)
			const toolName = call.toolName ?? tracked?.name ?? "vscode-editor-tools__unknown"
			let parsedInput: unknown = call.input
			if (parsedInput === undefined && tracked?.arguments) {
				try {
					parsedInput = JSON.parse(tracked.arguments)
				} catch {
					parsedInput = { raw: tracked.arguments }
				}
			}
			if (!this.requestToolApproval) {
				// No UI wired (headless/test): auto-approve read-only tools, reject writes.
				const readOnly = /^(vscode-editor-tools__)?editor_(read_file|search|retrieve|repo_map|diagnostics)$/.test(String(toolName))
				const decision = readOnly ? "allow" : "deny"
				await this.client.sendToolApproval(sessionId, turnId, approval.threadId, call.id, { status: decision as "allow" | "deny" })
				continue
			}
			const decision = await this.requestToolApproval({
				toolCallId: call.id,
				toolName: String(toolName),
				input: parsedInput,
				iteration: state?.turn?.iteration ?? 1,
				agentId: sessionId,
				conversationId: sessionId,
				policy: { enabled: true, autoApprove: false },
			})
			await this.client.sendToolApproval(sessionId, turnId, approval.threadId, call.id, {
				status: decision.approved ? "allow" : "deny",
				reason: decision.reason,
			})
		}
	}

	async abort(sessionId: string, _reason?: unknown): Promise<void> {
		try {
			await this.client.cancelTurn(sessionId)
		} catch (error) {
			Logger.warn(`[TrueForge] cancel failed: ${error instanceof Error ? error.message : String(error)}`)
		}
		this.emit({ type: "ended", payload: { sessionId, reason: "aborted", ts: Date.now() } } as CoreSessionEvent)
	}

	async stop(sessionId: string): Promise<void> {
		await this.abort(sessionId, "stop")
		this.sessions.delete(sessionId)
	}

	async dispose(_reason?: string): Promise<void> {
		this.listeners.clear()
		this.sessions.clear()
	}

	async get(sessionId: string): Promise<SessionRecord | undefined> {
		const state = this.sessions.get(sessionId)
		if (!state) return undefined
		return this.toRecord(sessionId, state)
	}

	async list(limit = 50, _options?: { cwd?: string; includeManifestFallback?: boolean; hydrate?: boolean; includeSubagents?: boolean }): Promise<SessionHistoryRecord[]> {
		const records: SessionHistoryRecord[] = []
		for (const [sessionId, state] of [...this.sessions.entries()].slice(-limit)) {
			records.push(this.toRecord(sessionId, state))
		}
		return records
	}

	async listHistory(options?: { limit?: number; cwd?: string }): Promise<SessionHistoryRecord[]> {
		const limit = options?.limit ?? 50
		return this.list(limit, { cwd: options?.cwd })
	}

	async delete(sessionId: string): Promise<boolean> {
		return this.sessions.delete(sessionId)
	}

	private toRecord(sessionId: string, state: { createdAt: string; cwd: string; prompt: string }): SessionHistoryRecord {
		return {
			sessionId,
			source: "trueforge",
			status: "completed",
			isSubagent: false,
			startedAt: state.createdAt,
			updatedAt: state.createdAt,
			interactive: true,
			provider: "trueforge",
			model: "trueforge-agent",
			cwd: state.cwd,
			workspaceRoot: state.cwd,
			enableTools: true,
			enableSpawn: true,
			enableTeams: false,
			prompt: state.prompt,
			metadata: { prompt: state.prompt },
		} as SessionHistoryRecord
	}

	async getAccumulatedUsage(_sessionId: string): Promise<SessionAccumulatedUsage | undefined> {
		return undefined
	}

	async readMessages(_sessionId: string): Promise<SdkInitialMessages> {
		// TrueForge persists turn events server-side; reconstructing Cline-style messages is not needed for the demo.
		return [] as unknown as SdkInitialMessages
	}

	async readLiveMessages(sessionId: string): Promise<SdkInitialMessages> {
		const text = this.sessions.get(sessionId)?.turn?.contentAccumulator.text
		if (!text) {
			return [] as unknown as SdkInitialMessages
		}
		return [
			{ role: "assistant", content: text } as unknown as SdkInitialMessages[number],
		] as unknown as SdkInitialMessages
	}

	async updateSessionCompactionState(_sessionId: string, _state: SessionCompactionState): Promise<{ updated: boolean }> {
		return { updated: false }
	}

	async compareCheckpoint(_input: { sessionId: string; cwd?: string; runCount?: number }): Promise<CompareCheckpointResult> {
		return {
			successful: false,
			error: "TrueForge has no local checkpoints in this environment",
			diffs: [],
			summary: { filesChanged: 0, additions: 0, deletions: 0 },
		} as unknown as CompareCheckpointResult
	}

	async update(sessionId: string, updates: { prompt?: string | null; metadata?: Record<string, unknown> | null; title?: string | null }): Promise<{ updated: boolean }> {
		const state = this.sessions.get(sessionId)
		if (!state) return { updated: false }
		if (typeof updates.prompt === "string") state.prompt = updates.prompt
		void updates.metadata
		void updates.title
		return { updated: true }
	}

	async handleHookEvent(_payload: HookEventPayload): Promise<void> {
		// No-op: not needed for the Forge demo path.
	}

	pendingPrompts(action: "list", _input: PendingPromptsListInput): Promise<SessionPendingPrompt[]>
	pendingPrompts(action: "update", _input: PendingPromptsUpdateInput): Promise<PendingPromptMutationResult>
	pendingPrompts(action: "delete", _input: PendingPromptsDeleteInput): Promise<PendingPromptMutationResult>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	pendingPrompts(action: any, _input: any): any {
		switch (action) {
			case "list":
				return Promise.resolve([])
			case "update":
				return Promise.resolve({ prompt: undefined, prompts: [] })
			case "delete":
				return Promise.resolve({ deleted: false })
			default:
				throw new Error(`Unsupported pending prompt action: ${String(action)}`)
		}
	}

	updateSessionModel?(sessionId: string, modelId: string): Promise<void> {
		Logger.log(`[TrueForge] updateSessionModel ignored (model pinned in TrueForge settings): session=${sessionId} model=${modelId}`)
		return Promise.resolve()
	}

	// ---- subscribe ----

	subscribe(listener: (event: CoreSessionEvent) => void): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	private emit(event: CoreSessionEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event)
			} catch (error) {
				Logger.error("[TrueForge] listener threw:", error)
			}
		}
	}
}
