/**
 * TrueForge client — thin wrapper around the SDK used by the extension.
 * Everything model-related goes through TrueForge (npx @truefoundry/trueforge).
 * This client never talks to a provider directly.
 */

import { TrueForge } from "@truefoundry/trueforge-sdk"
import type * as TF from "@truefoundry/trueforge-sdk"

export type TFAgentSpec = TF.CreateSessionRequestAgentInline
export type TFTurnStreamEvent = TF.TurnStreamingEvent

export class TrueForgeClient {
	private readonly sdk: TrueForge

	constructor(baseUrl = "http://localhost:8790") {
		this.sdk = new TrueForge({ baseURL: baseUrl.replace(/\/$/, "") })
	}

	get raw(): TrueForge {
		return this.sdk
	}

	async listConfiguredModels(limit = 100) {
		const pageable = await this.sdk.settings.modelProviders.list()
		const providers = pageable?.data ?? []
		return providers.map((p: unknown) => p as { name?: string })
	}

	async createInlineSession(spec: TFAgentSpec["spec"]) {
		const result = await this.sdk.sessions.create({
			agent: { spec },
		} as TF.CreateSessionRequest)
		const id = (result as unknown as { data: { id: string } }).data?.id
		if (!id) {
			throw new Error("TrueForge session did not return an id")
		}
		return id
	}

	/** Stream events from a new turn; caller iterates with for await. */
	async *streamTurn(sessionId: string, prompt: string): AsyncGenerator<TFTurnStreamEvent, void, unknown> {
		const stream = await this.sdk.sessions.createTurnStream(sessionId, {
			input: [{ type: "user.message", content: prompt }],
		} as TF.CreateTurnSessionsStreamRequest)
		for await (const event of stream as AsyncIterable<TFTurnStreamEvent>) {
			yield event
		}
	}

	/** Await completion of a turn; used for non-streaming checks. */
	async sendTurn(sessionId: string, prompt: string): Promise<void> {
		const stream = await this.sdk.sessions.createTurnStream(sessionId, {
			input: [{ type: "user.message", content: prompt }],
		} as TF.CreateTurnSessionsStreamRequest)
		for await (const event of stream as AsyncIterable<TFTurnStreamEvent>) {
			// Drain.
			void event
		}
	}

	async cancelTurn(sessionId: string): Promise<void> {
		await this.sdk.sessions.cancel(sessionId)
	}

	async sendToolApproval(
		sessionId: string,
		turnId: string,
		threadId: string,
		toolCallId: string,
		approval: TF.ApprovalDecision,
	): Promise<void> {
		await this.sdk.sessions.createTurnEvents(sessionId, turnId, {
			events: [
				{
					type: "user.tool_approval",
					id: `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					createdAt: new Date().toISOString(),
					threadId,
					toolCallId,
					approval,
				} satisfies TF.UserToolApprovalEvent,
			],
		} as unknown as TF.CreateTurnEventRequest)
	}
}
