/**
 * Approval input resolution over a real event stream.
 *
 * The defect these pin down: TrueForge streams a tool call as one delta that carries
 * the id and `function.name`, followed by many deltas that carry only
 * `function.arguments` fragments and an `index`. The host ignored the fragment deltas,
 * so the tracked arguments stayed `""` and the approval review received `{}` — no
 * path, no hunks. With the fail-closed write path that means every interactive edit is
 * refused; without it, it means the old silent accept-everything write. Neither is
 * acceptable, so the fragments are now accumulated by index.
 */

import { describe, expect, test } from "vitest"
import type { TrueForgeClient } from "./client"
import { TrueForgeSessionHost } from "./trueforge-session-host"

const startInput = (prompt: string) => ({ prompt }) as unknown as Parameters<TrueForgeSessionHost["start"]>[0]

const FULL_ARGS = JSON.stringify({
	path: "src/flask/helpers.py",
	summary: "treat off/n as false",
	edits: [{ oldText: 'return val not in ("0", "false", "no")', newText: 'return val not in ("0", "false", "no", "off", "n")' }],
})

function streamedApprovalStub(toolName: string) {
	let settle!: () => void
	const answered = new Promise<void>((resolve) => {
		settle = resolve
	})
	const approvals: Array<{ toolCallId: string; status: string }> = []
	const client = {
		async createInlineSession() {
			return "sess-stream"
		},
		async *streamTurn() {
			yield { type: "turn.created", turnId: "turn-1" }
			// First delta: id + tool name, zero argument characters.
			yield {
				type: "model.message.delta",
				id: "msg-1",
				toolCalls: [
					{
						index: 0,
						id: "call-1",
						type: "function",
						toolInfo: { type: "mcp", name: toolName },
						function: { name: toolName, arguments: "" },
					},
				],
			}
			// Argument fragments: no id, only the index.
			for (const fragment of [FULL_ARGS.slice(0, 20), FULL_ARGS.slice(20, 60), FULL_ARGS.slice(60)]) {
				yield { type: "model.message.delta", id: "msg-1", toolCalls: [{ index: 0, function: { arguments: fragment } }] }
			}
			yield {
				type: "tool.approval_required",
				id: "appr-1",
				threadId: "main",
				toolCalls: [{ id: "call-1", sourceEventId: "msg-1" }],
			}
			await answered
			yield { type: "turn.done", state: { status: "done" } }
		},
		async cancelTurn() {},
		async switchModel() {},
		async sendToolApproval(_s: string, _t: string, _th: string, toolCallId: string, approval: { status: string }) {
			approvals.push({ toolCallId, status: approval.status })
			settle()
		},
		async updateSession() {},
	} as unknown as TrueForgeClient
	return { client, approvals }
}

describe("approval input from streamed tool-call fragments", () => {
	test("the approval request receives the fully accumulated arguments", async () => {
		const stub = streamedApprovalStub("editor_propose_edit")
		const seen: Array<{ toolName: string; input: unknown }> = []
		const host = await TrueForgeSessionHost.create({
			extensionPath: process.cwd(),
			client: stub.client,
			sleep: async () => {},
			requestToolApproval: async (request) => {
				seen.push({ toolName: request.toolName, input: request.input })
				return { approved: false, reason: "test denies writes" }
			},
		})
		const started = await host.start(startInput("edit helpers"))
		await host.send({ sessionId: started.sessionId, prompt: "edit helpers" })

		expect(seen).toHaveLength(1)
		expect(seen[0]?.toolName).toBe("editor_propose_edit")
		expect(seen[0]?.input).toEqual(JSON.parse(FULL_ARGS))
		// The denial is forwarded, so no write can run.
		expect(stub.approvals).toEqual([{ toolCallId: "call-1", status: "deny" }])
	})
})
