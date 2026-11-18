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
import type {
	AgentContentEndEvent,
	AgentContentStartEvent,
	AgentDoneEvent,
	AgentErrorEvent,
	AgentEvent,
	AgentIterationStartEvent,
	AgentResult,
	AgentUsageEvent as TFAgentUsageEvent,
} from "@cline/shared"
import { Logger } from "@shared/services/Logger"
import type { SdkInitialMessages, SdkSessionHost } from "../sdk/session-host"
import { type ForgeAgentSpec, TrueForgeClient } from "./client"
import { resolveMentionContext } from "./mcp/tools"
import { attemptOrder, decideFallback, decideRetry, defaultSleep, exhaustedMessage, modelChainFromSpec } from "./model-fallback"

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
			if (parsed?.model?.name && parsed.instructions) {
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
	/** Test seam: replaces the backoff sleep so retry tests run instantly. */
	sleep?: (ms: number) => Promise<void>
}

interface TurnState {
	turnId?: string
	threadId?: string
	startedAt: string
	iteration: number
	contentAccumulator: { id?: string; text: string; toolCalls: Map<string, { name: string; arguments: string; id: string }> }
	usage: { inputTokens: number; outputTokens: number; cost: number }
	finished: boolean
	/** Terminal status of the current turn, as reported by `turn.done`. */
	terminalStatus?: string
	/** The harness's failure message for the current turn, if any. */
	terminalMessage?: string
}

function nowIso(): string {
	return new Date().toISOString()
}

/**
 * Resolve the input of a tool awaiting TrueForge approval.
 *
 * The harness approval event identifies a tool call by ID but frequently sends an
 * empty `input` object; the real arguments are on the tracked `model.message` tool
 * call. Taking the empty object at face value makes the diff review see no path or
 * hunks and silently fall back to a bare Approve button, so prefer the tracked
 * arguments whenever the approval input carries nothing.
 */
export function resolveApprovalInput(callInput: unknown, trackedArguments?: string): unknown {
	const empty =
		callInput === undefined || (typeof callInput === "object" && callInput !== null && Object.keys(callInput).length === 0)
	if (!empty || !trackedArguments) {
		return callInput
	}
	try {
		return JSON.parse(trackedArguments)
	} catch {
		return { raw: trackedArguments }
	}
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
	/** Backoff sleep; injectable so tests do not wait real time. */
	private readonly sleep: (ms: number) => Promise<void>
	/** sessionId (=TF session id) */
	private readonly sessions = new Map<string, { turn?: TurnState; createdAt: string; cwd: string; prompt: string }>()

	private constructor(options: TrueForgeSessionHostOptions) {
		this.url = (options.trueforgeUrl ?? process.env.TRUEFORGE_URL ?? "http://localhost:8790").replace(/\/$/, "")
		this.runtimeAddress = this.url
		this.extensionPath = options.extensionPath
		this.client = new TrueForgeClient(this.url)
		this.requestToolApproval = options.requestToolApproval
		this.sleep = options.sleep ?? defaultSleep
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
		this.emit(
			stageEvent(sessionId, {
				type: "iteration_start",
				iteration: turn.iteration,
				agentId: sessionId,
				conversationId: sessionId,
			} as AgentIterationStartEvent),
		)
		// Model fallback: if the configured model is unreachable or rejects the key,
		// retry the same prompt on the next model in the chain with no user action.
		// Only when every model has failed do we surface an error to the user.
		const chain = modelChainFromSpec(loadForgeAgentSpec(this.extensionPath).model)
		const order = attemptOrder(chain)
		let modelIndex = 0
		let activeModel = order[0] ?? ""
		let modelAttempts = 0
		let lastError: unknown
		// Explicit `@file` / `@symbol` mentions are resolved to real text before the
		// model sees anything, and prepended un-evictable. Retrieval then fills the rest.
		const mentionContext = resolveMentionContext({ root: state.cwd }, input.prompt)
		if (mentionContext.contextText) {
			Logger.log(
				`[TrueForge] resolved mentions: files=${mentionContext.files.length} symbols=${mentionContext.symbols.length}`,
			)
		}
		const promptWithMentions = mentionContext.contextText
			? `${mentionContext.contextText}\n\n---\n\nUser request: ${mentionContext.promptText}`
			: input.prompt

		/**
		 * One failure, handled in the order the brief asks for: retry the same model with
		 * backoff while the error looks transient, then move to the next configured model,
		 * then give up with a message naming everything that was tried.
		 */
		const handleFailure = async (error: unknown): Promise<"retried" | "failed_over" | "stop"> => {
			lastError = error
			const retry = decideRetry(activeModel, error, modelAttempts)
			if (retry.shouldRetry) {
				Logger.warn(`[TrueForge] ${retry.note}`)
				this.emit(
					stageEvent(sessionId, {
						type: "content_start",
						contentType: "text",
						text: `\n\n[Forge] ${retry.note}\n\n`,
						accumulated: turn.contentAccumulator.text,
						agentId: sessionId,
						conversationId: sessionId,
					} as AgentContentStartEvent),
				)
				await this.sleep(retry.delayMs)
				return "retried"
			}
			const decision = decideFallback(chain, activeModel, error, modelIndex + 1)
			Logger.warn(`[TrueForge] ${decision.note}`)
			if (decision.shouldFailover && decision.next) {
				await this.failoverTo(sessionId, turn, decision.next, decision.note)
				modelIndex = decision.nextIndex ?? modelIndex + 1
				activeModel = decision.next
				modelAttempts = 0
				return "failed_over"
			}
			return "stop"
		}

		for (;;) {
			modelAttempts += 1
			turn.terminalStatus = undefined
			turn.terminalMessage = undefined
			try {
				for await (const event of this.client.streamTurn(sessionId, promptWithMentions)) {
					this.handleTurnEvent(sessionId, event as Record<string, unknown>)
				}
				// A turn can end in error without throwing: TrueForge reports model failures
				// as `turn.done { status: "error" }` on the stream. Treat that like a stream
				// error so retry, failover and the exhausted message all work for Task C.
				if (turn.terminalStatus === "cancelled") {
					// The user stopped this turn; retrying would defeat the cancellation.
					lastError = undefined
					break
				}
				if (turn.terminalStatus === "error" || turn.terminalStatus === "failed") {
					const outcome = await handleFailure(new Error(turn.terminalMessage || "TrueForge turn failed"))
					if (outcome === "stop") {
						// The terminal error was already surfaced by the turn.done handler.
						break
					}
					continue
				}
				lastError = undefined
				break
			} catch (error) {
				const outcome = await handleFailure(error)
				if (outcome === "stop") {
					break
				}
			}
		}
		if (lastError !== undefined) {
			const message = exhaustedMessage(chain, lastError)
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
				} else if (turn?.contentAccumulator.text) {
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
				if (stateKind === "done" || stateKind === "cancelled" || stateKind === "failed" || stateKind === "error") {
					const isError = stateKind === "failed" || stateKind === "error"
					const reason = stateKind === "done" ? "stop" : stateKind === "cancelled" ? "aborted" : "error"
					const failureMessage = done.state?.message?.trim()
					// Record the terminal state so the turn driver can decide whether this is a
					// model-availability failure worth failing over, or a task failure to report.
					if (turn) {
						turn.terminalStatus = stateKind
						turn.terminalMessage = failureMessage
					}
					const accumulated = turn?.contentAccumulator.text ?? ""
					// Surface the harness's own failure message when the model call dies
					// before any text was produced — otherwise the chat renders nothing.
					const text = accumulated || failureMessage || ""
					if (isError) {
						this.emit(
							stageEvent(sessionId, {
								type: "error",
								error: new Error(failureMessage ?? "TrueForge turn failed"),
								recoverable: false,
								iteration: turn?.iteration ?? 1,
								agentId: sessionId,
								conversationId: sessionId,
							} as AgentErrorEvent),
						)
					}
					this.emit(
						stageEvent(sessionId, {
							type: "done",
							reason: reason as AgentDoneEvent["reason"],
							iterations: turn?.iteration ?? 1,
							text,
							agentId: sessionId,
							conversationId: sessionId,
						} as AgentDoneEvent),
					)
					this.emit({
						type: "ended",
						payload: { sessionId, reason: reason === "error" ? "error" : "completed", ts: Date.now() },
					} as CoreSessionEvent)
					if (turn) {
						turn.finished = true
					}
				}
				return
			}
			case "thread.context_compaction_started": {
				// TrueForge is compacting the thread because it crossed the token
				// threshold. Surfacing it matters: compaction is the reason a long Task B
				// session keeps working after the repo stops fitting, and a judge needs to
				// see the harness doing it rather than take it on faith.
				const started = event as unknown as {
					trigger?: { context_tokens?: number; threshold_tokens?: number }
				}
				const tokens = started.trigger?.context_tokens
				const threshold = started.trigger?.threshold_tokens
				const detail =
					tokens !== undefined && threshold !== undefined
						? `context reached ${tokens} tokens (threshold ${threshold})`
						: "context threshold reached"
				this.emitToolNote(
					sessionId,
					`[TrueForge] compacting thread context — ${detail}. Older turns are summarised so the task can continue.`,
				)
				return
			}
			case "thread.context_compaction_finished": {
				const finished = event as unknown as { duration_ms?: number }
				this.emitToolNote(
					sessionId,
					`[TrueForge] context compaction finished in ${finished.duration_ms ?? 0}ms; the thread continues inside the window.`,
				)
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

	/**
	 * Append a short harness note to the transcript as ordinary assistant text. Used
	 * for TrueForge's own context-engineering events (compaction, failover, retries)
	 * so the user sees what the harness did on their behalf instead of inferring it
	 * from a changed window.
	 */
	private emitToolNote(sessionId: string, text: string): void {
		const state = this.sessions.get(sessionId)
		const accumulated = state?.turn?.contentAccumulator.text ?? ""
		this.emit(
			stageEvent(sessionId, {
				type: "content_start",
				contentType: "text",
				text: `\n\n${text}\n\n`,
				accumulated,
				agentId: sessionId,
				conversationId: sessionId,
			} as AgentContentStartEvent),
		)
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
			const parsedInput = resolveApprovalInput(call.input, tracked?.arguments)
			if (!this.requestToolApproval) {
				// No UI wired (headless/test): auto-approve read-only tools, reject writes.
				const readOnly = /^(vscode-editor-tools__)?editor_(read_file|search|retrieve|repo_map|diagnostics)$/.test(
					String(toolName),
				)
				const decision = readOnly ? "allow" : "deny"
				await this.client.sendToolApproval(sessionId, turnId, approval.threadId, call.id, {
					status: decision as "allow" | "deny",
				})
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

	/**
	 * Hand the turn to the next configured model: re-point the inline session, tell the
	 * user in the transcript, and clear the accumulator so the retry does not duplicate
	 * text. Failing to switch is logged but not fatal — the retry still runs.
	 */
	private async failoverTo(sessionId: string, turn: TurnState, nextModel: string, note: string): Promise<void> {
		this.emit(
			stageEvent(sessionId, {
				type: "content_start",
				contentType: "text",
				text: `\n\n[Forge] ${note}\n\n`,
				accumulated: turn.contentAccumulator.text,
				agentId: sessionId,
				conversationId: sessionId,
			} as AgentContentStartEvent),
		)
		try {
			await this.client.switchModel(sessionId, loadForgeAgentSpec(this.extensionPath), nextModel)
			Logger.log(`[TrueForge] session ${sessionId} switched to ${nextModel}`)
		} catch (switchError) {
			Logger.warn(
				`[TrueForge] could not switch session to ${nextModel}: ${switchError instanceof Error ? switchError.message : String(switchError)}`,
			)
		}
		turn.contentAccumulator = { text: "", toolCalls: new Map() }
		turn.terminalStatus = undefined
		turn.terminalMessage = undefined
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

	async list(
		limit = 50,
		_options?: { cwd?: string; includeManifestFallback?: boolean; hydrate?: boolean; includeSubagents?: boolean },
	): Promise<SessionHistoryRecord[]> {
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
		return [{ role: "assistant", content: text } as unknown as SdkInitialMessages[number]] as unknown as SdkInitialMessages
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

	async update(
		sessionId: string,
		updates: { prompt?: string | null; metadata?: Record<string, unknown> | null; title?: string | null },
	): Promise<{ updated: boolean }> {
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
	// biome-ignore lint/suspicious/noExplicitAny: single-shape overload fallback for unknown action strings
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
		Logger.log(
			`[TrueForge] updateSessionModel ignored (model pinned in TrueForge settings): session=${sessionId} model=${modelId}`,
		)
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
