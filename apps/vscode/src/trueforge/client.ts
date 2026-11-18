/**
 * TrueForge client — thin wrapper around the SDK used by the extension.
 * Everything model-related goes through TrueForge (npx @truefoundry/trueforge).
 * This client never talks to a provider directly.
 */

import { TrueForge } from "@truefoundry/trueforge-sdk"

/** The agent definition loaded from .trueforge/agents/forge-editor.json (or the built-in default). */
export interface ForgeAgentSpec {
	instructions: string
	model: { name: string; fallbacks?: string[] }
	mcp_servers?: Array<Record<string, unknown>>
	config?: Record<string, unknown>
}

export class TrueForgeClient {
	private readonly sdk: TrueForge

	constructor(baseUrl = "http://localhost:8790") {
		this.sdk = new TrueForge({ baseUrl: baseUrl.replace(/\/$/, "") })
	}

	get raw(): TrueForge {
		return this.sdk
	}

	async createInlineSession(spec: ForgeAgentSpec): Promise<string> {
		const result = await this.sdk.sessions.create({
			agent: { spec },
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			// biome-ignore lint/suspicious/noExplicitAny: TrueForge SDK surfaces untyped agent/session shapes
		} as any)
		const id = (result as unknown as { data?: { id?: string } }).data?.id
		if (!id) {
			throw new Error("TrueForge session did not return an id")
		}
		return id
	}

	/** Stream events from a turn; caller iterates with for await. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async *streamTurn(sessionId: string, prompt: string): AsyncGenerator<unknown, void, unknown> {
		const stream = await this.sdk.sessions.createTurnStream(sessionId, {
			input: [{ type: "user.message", content: prompt }],
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			// biome-ignore lint/suspicious/noExplicitAny: TrueForge SDK surfaces untyped agent/session shapes
		} as any)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		for await (const event of stream as AsyncIterable<unknown>) {
			yield event
		}
	}

	/** Drain a turn to completion; used for non-streaming health checks. */
	async sendTurn(sessionId: string, prompt: string): Promise<void> {
		const stream = await this.sdk.sessions.createTurnStream(sessionId, {
			input: [{ type: "user.message", content: prompt }],
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			// biome-ignore lint/suspicious/noExplicitAny: TrueForge SDK surfaces untyped agent/session shapes
		} as any)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		for await (const _event of stream as AsyncIterable<unknown>) {
			// drain
		}
	}

	async cancelTurn(sessionId: string): Promise<void> {
		await this.sdk.sessions.cancel(sessionId)
	}

	/**
	 * Re-point an inline session at a different model. Inline sessions accept an
	 * agent-spec update; named sessions reject it, which is why Forge always creates
	 * inline sessions from the committed agent definition.
	 */
	async switchModel(sessionId: string, spec: ForgeAgentSpec, modelName: string): Promise<void> {
		const nextSpec: ForgeAgentSpec = { ...spec, model: { ...spec.model, name: modelName } }
		await this.sdk.sessions.update(sessionId, {
			agent: { spec: nextSpec },
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			// biome-ignore lint/suspicious/noExplicitAny: TrueForge SDK surfaces untyped agent/session shapes
		} as any)
	}

	async sendToolApproval(
		sessionId: string,
		turnId: string,
		threadId: string,
		toolCallId: string,
		approval: { status: "allow" | "deny"; reason?: string },
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
				},
			],
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			// biome-ignore lint/suspicious/noExplicitAny: TrueForge SDK surfaces untyped agent/session shapes
		} as any)
	}

	/** Lightweight health check: can we reach TrueForge and list configured models? */
	async ping(): Promise<{ ok: true; providers: string[] } | { ok: false; error: string }> {
		try {
			const providers = await this.sdk.settings.modelProviders.list()
			const names = ((providers as unknown as { data?: Array<{ name?: string }> }).data ?? [])
				.map((p) => p?.name)
				.filter((n): n is string => typeof n === "string")
			return { ok: true, providers: names }
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			// Fall back to sessions list; some builds expose fewer routes.
			try {
				await this.sdk.sessions.list({ limit: 1 })
				return { ok: true, providers: [] }
			} catch {
				return { ok: false, error: message }
			}
		}
	}
}
