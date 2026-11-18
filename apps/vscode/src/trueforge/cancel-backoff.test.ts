/**
 * Cancellation during retry backoff.
 *
 * The defect these pin down: the retry loop slept between attempts with no way to
 * interrupt it, and nothing checked whether the user had cancelled. A cancel issued
 * while the loop was waiting out a backoff would still be followed by another model
 * call — the turn kept running after the user stopped it.
 *
 * These drive the real `TrueForgeSessionHost` retry loop with a stub client, so the
 * loop logic is exercised for real while no model is involved.
 */

import { describe, expect, test } from "vitest"
import type { TrueForgeClient } from "./client"
import { TrueForgeSessionHost } from "./trueforge-session-host"

/** The host only reads `prompt`; the SdkSessionHost input type wants a full config. */
const startInput = (prompt: string) => ({ prompt }) as unknown as Parameters<TrueForgeSessionHost["start"]>[0]

/** Minimal stand-in for TrueForgeClient that fails turns on demand. */
function stubClient(options: {
	/** How many turns fail before one succeeds. Infinity = always fail. */
	failures: number
	/** Called on each turn request, so a test can cancel from inside the loop. */
	onTurn?: (turnIndex: number) => void
}) {
	let turns = 0
	const client = {
		async createInlineSession() {
			return "sess-1"
		},
		async *streamTurn() {
			turns += 1
			const index = turns
			options.onTurn?.(index)
			if (index <= options.failures) {
				// A transient transport failure delivered on the stream, exactly like a
				// real `turn.done { status: "error" }`.
				yield { type: "turn.done", state: { status: "error", message: "fetch failed: ECONNRESET" } }
				return
			}
			yield { type: "turn.done", state: { status: "done" } }
		},
		async cancelTurn() {},
		async switchModel() {},
		async sendToolApproval() {},
		async updateSession() {},
	} as unknown as TrueForgeClient
	return { client, turnCount: () => turns }
}

describe("cancel while a tool approval is pending", () => {
	/** A stream that pauses at a tool approval until the host answers it. */
	function approvalStub() {
		const approvals: Array<{ toolCallId: string; status: string; reason?: string }> = []
		let settle!: () => void
		const answered = new Promise<void>((resolve) => {
			settle = resolve
		})
		let turnCount = 0
		const client = {
			async createInlineSession() {
				return "sess-approval"
			},
			async *streamTurn() {
				turnCount += 1
				yield { type: "turn.created", turnId: "turn-1" }
				yield {
					type: "tool.approval_required",
					id: "approval-1",
					threadId: "thread-1",
					toolCalls: [
						{
							id: "call-1",
							sourceEventId: "src-1",
							toolName: "vscode-editor-tools__editor_propose_edit",
							input: { path: "helpers.py", edits: [{ oldText: "a", newText: "b" }] },
						},
					],
				}
				// The real stream stays open until the user answers the approval.
				await answered
				yield { type: "turn.done", state: { status: "done" } }
			},
			async cancelTurn() {},
			async switchModel() {},
			async sendToolApproval(
				_s: string,
				_t: string,
				_th: string,
				toolCallId: string,
				approval: { status: string; reason?: string },
			) {
				approvals.push({ toolCallId, status: approval.status, reason: approval.reason })
				settle()
			},
			async updateSession() {},
		} as unknown as TrueForgeClient
		return { client, approvals, turnCount: () => turnCount }
	}

	test("an approval granted after the user cancelled is forwarded as a denial", async () => {
		const stub = approvalStub()
		let host: TrueForgeSessionHost
		let approvalPrompts = 0
		host = await TrueForgeSessionHost.create({
			extensionPath: process.cwd(),
			client: stub.client,
			sleep: async () => {},
			requestToolApproval: async () => {
				approvalPrompts += 1
				// The user stops the task while the approval is on screen, then the
				// (now stale) dialog resolves as approved.
				await host.abort("sess-approval")
				return { approved: true }
			},
		})
		const started = await host.start(startInput("edit helpers"))
		await host.send({ sessionId: started.sessionId, prompt: "edit helpers" })

		expect(approvalPrompts).toBe(1)
		expect(stub.approvals).toHaveLength(1)
		expect(stub.approvals[0]?.toolCallId).toBe("call-1")
		// Critical: the approved-after-cancel decision must not reach the tool as "allow".
		expect(stub.approvals[0]?.status).toBe("deny")
		expect(stub.approvals[0]?.reason).toContain("cancelled")
	})

	test("an approval while the turn is live is forwarded as an allow", async () => {
		const stub = approvalStub()
		const host = await TrueForgeSessionHost.create({
			extensionPath: process.cwd(),
			client: stub.client,
			sleep: async () => {},
			requestToolApproval: async () => ({ approved: true }),
		})
		const started = await host.start(startInput("edit helpers"))
		await host.send({ sessionId: started.sessionId, prompt: "edit helpers" })
		expect(stub.approvals[0]?.status).toBe("allow")
	})
})

describe("abort responsiveness", () => {
	test("abort returns promptly even when the harness cancel request hangs", async () => {
		const client = {
			async createInlineSession() {
				return "sess-hang"
			},
			async *streamTurn() {
				yield { type: "turn.created", turnId: "turn-1" }
			},
			// A harness that accepts the cancel request and never answers it.
			cancelTurn: () => new Promise<void>(() => {}),
			async switchModel() {},
			async sendToolApproval() {},
			async updateSession() {},
		} as unknown as TrueForgeClient
		const host = await TrueForgeSessionHost.create({
			extensionPath: process.cwd(),
			client,
			sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
			cancelRequestTimeoutMs: 50,
		})
		const started = await host.start(startInput("hang"))
		const t0 = Date.now()
		await host.abort(started.sessionId)
		// Bounded by cancelRequestTimeoutMs, not by the harness's hung request.
		expect(Date.now() - t0).toBeLessThan(1_000)
	})
})

describe("cancel while the stream is in flight", () => {
	test("an aborted stream is reported as an abort, not a model error", async () => {
		const emittedErrors: string[] = []
		const client = {
			async createInlineSession() {
				return "sess-abort"
			},
			async *streamTurn() {
				yield { type: "turn.created", turnId: "turn-1" }
				// The aborted HTTP stream throws a little after the user hits stop.
				await new Promise((resolve) => setTimeout(resolve, 30))
				throw new Error("The operation was aborted")
			},
			async cancelTurn() {},
			async switchModel() {},
			async sendToolApproval() {},
			async updateSession() {},
		} as unknown as TrueForgeClient
		const host = await TrueForgeSessionHost.create({
			extensionPath: process.cwd(),
			client,
			sleep: async () => {},
		})
		host.subscribe((event) => {
			if (event.type === "agent_event" && event.payload.event.type === "error") {
				emittedErrors.push(String(event.payload.event.error))
			}
		})
		const started = await host.start(startInput("stop me"))
		const sending = host.send({ sessionId: started.sessionId, prompt: "stop me" })
		setTimeout(() => void host.abort(started.sessionId), 5)
		const result = await sending

		// The user's cancel must not surface as a [Model Error] with Retry.
		expect(result?.finishReason).not.toBe("error")
		expect(emittedErrors).toHaveLength(0)
	})
})

describe("cancel during retry backoff", () => {
	test("a cancel issued during the backoff stops the loop before another turn", async () => {
		let host: TrueForgeSessionHost
		let sleepCalls = 0
		const stub = stubClient({ failures: Number.POSITIVE_INFINITY })
		host = await TrueForgeSessionHost.create({
			extensionPath: process.cwd(),
			client: stub.client,
			// The seam cancels from inside the backoff — exactly the window the bug lived in.
			sleep: async () => {
				sleepCalls += 1
				await host.abort("sess-1")
			},
		})
		const started = await host.start(startInput("do the thing"))
		await host.send({ sessionId: started.sessionId, prompt: "do the thing" })

		expect(sleepCalls).toBeGreaterThan(0)
		// One attempt, then the cancel lands during its backoff: no further turns.
		expect(stub.turnCount()).toBe(1)
	})

	test("without a cancel the loop does retry the same model", async () => {
		const stub = stubClient({ failures: 1 })
		const host = await TrueForgeSessionHost.create({
			extensionPath: process.cwd(),
			client: stub.client,
			sleep: async () => {},
		})
		const started = await host.start(startInput("do the thing"))
		await host.send({ sessionId: started.sessionId, prompt: "do the thing" })
		// First attempt failed transiently, the retry succeeded.
		expect(stub.turnCount()).toBe(2)
	})

	test("a turn that succeeds first time is not retried", async () => {
		const stub = stubClient({ failures: 0 })
		const host = await TrueForgeSessionHost.create({
			extensionPath: process.cwd(),
			client: stub.client,
			sleep: async () => {},
		})
		const started = await host.start(startInput("do the thing"))
		await host.send({ sessionId: started.sessionId, prompt: "do the thing" })
		expect(stub.turnCount()).toBe(1)
	})
})
