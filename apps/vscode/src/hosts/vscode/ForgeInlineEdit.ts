/**
 * Inline edit — VS Code command surface.
 *
 * Select code, press the keybinding (Cmd/Ctrl+Alt+K), type an instruction in the
 * input box. The turn goes to TrueForge like every other turn (this file never calls
 * a model provider). The reply is parsed into exact hunks and shown as a real diff
 * tab; the user accepts or rejects per hunk, and only then is the file written.
 *
 * Nothing here writes to disk before acceptance, and every applied edit records its
 * pre-image so `Forge: Undo Last Edit` restores exact bytes.
 */

import { readFileSync, writeFileSync } from "node:fs"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { type ForgeAgentSpec, TrueForgeClient } from "@/trueforge/client"
import type { EditHunk } from "@/trueforge/edits"
import { applyAcceptedHunks, buildInlineEditPrompt, type InlineEditRequest, planInlineEdit } from "@/trueforge/inline-edit-core"
import { EDIT_PREVIEW_URI_SCHEME, editPreviewContentProvider } from "./VscodeEditPreview"

/** Pre-images of applied inline edits, newest last, for exact undo. */
interface UndoEntry {
	path: string
	before: string
	after: string
	at: number
}
const undoStack: UndoEntry[] = []

let previewCounter = 0

function loadAgentSpec(extensionPath: string): ForgeAgentSpec | undefined {
	const candidates = [
		`${extensionPath}/.trueforge/agents/forge-editor.json`,
		`${process.cwd()}/.trueforge/agents/forge-editor.json`,
		`${extensionPath}/../../.trueforge/agents/forge-editor.json`,
	]
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(readFileSync(candidate, "utf8")) as ForgeAgentSpec
			if (parsed?.model?.name) {
				return parsed
			}
		} catch {
			// try next
		}
	}
	return undefined
}

/** Drain a TrueForge turn and return the assistant's text. */
async function runInlineTurn(prompt: string, extensionPath: string): Promise<string> {
	const client = new TrueForgeClient(process.env.TRUEFORGE_URL ?? "http://localhost:8790")
	const spec = loadAgentSpec(extensionPath) ?? {
		instructions: "You are Forge. Reply with JSON only.",
		model: { name: process.env.FORGE_MODEL || "opencode-free-models/deepseek-v41-flash-free" },
	}
	// Inline edit is a single-shot completion: no editor tools, no agent loop needed.
	const inlineSpec: ForgeAgentSpec = {
		instructions: "You are Forge's inline edit engine. Reply with the requested JSON object only.",
		model: spec.model,
	}
	const sessionId = await client.createInlineSession(inlineSpec)
	let text = ""
	for await (const event of client.streamTurn(sessionId, prompt)) {
		const record = event as Record<string, unknown>
		if (record?.type === "model.message.delta") {
			const delta = record as { content?: string | null }
			if (delta.content) {
				text += delta.content
			}
		}
		if (record?.type === "turn.ended" || record?.type === "turn.failed") {
			break
		}
	}
	if (!text.trim()) {
		throw new Error("inline edit: TrueForge returned no text for this turn")
	}
	return text
}

/** Show the proposed hunks as a diff tab and collect per-hunk decisions. */
async function reviewHunks(
	request: InlineEditRequest,
	plan: ReturnType<typeof planInlineEdit>,
): Promise<{ accepted: boolean[] } | undefined> {
	const previewId = previewCounter++
	const leftUri = vscode.Uri.parse(`${EDIT_PREVIEW_URI_SCHEME}:${request.path}`).with({ query: `inline-${previewId}-left` })
	const rightUri = vscode.Uri.parse(`${EDIT_PREVIEW_URI_SCHEME}:${request.path}`).with({ query: `inline-${previewId}-right` })
	editPreviewContentProvider.set(leftUri, request.content)
	editPreviewContentProvider.set(rightUri, plan.proposed)

	await vscode.commands.executeCommand(
		"vscode.diff",
		leftUri,
		rightUri,
		`Forge inline edit: ${request.path} (${plan.hunks.length} hunk${plan.hunks.length === 1 ? "" : "s"})`,
		{ preview: false, preserveFocus: true },
	)

	try {
		// Per-hunk review: one modal per hunk, so a rejection is scoped to that hunk.
		const accepted: boolean[] = []
		for (const [index, hunk] of plan.hunks.entries()) {
			const preview = hunk.newText.length > 400 ? `${hunk.newText.slice(0, 400)}…` : hunk.newText
			const choice = await vscode.window.showInformationMessage(
				`Hunk ${index + 1}/${plan.hunks.length}${hunk.intent ? ` — ${hunk.intent}` : ""}\n\n${preview}`,
				{ modal: true },
				"Accept Hunk",
				"Reject Hunk",
			)
			if (choice === undefined) {
				// Dismissed: treat as rejecting the rest and stop asking.
				for (let rest = index; rest < plan.hunks.length; rest++) {
					accepted.push(false)
				}
				break
			}
			accepted.push(choice === "Accept Hunk")
		}
		return { accepted }
	} finally {
		editPreviewContentProvider.delete(leftUri)
		editPreviewContentProvider.delete(rightUri)
	}
}

/** The command behind the keybinding. */
export async function runInlineEdit(context: vscode.ExtensionContext): Promise<void> {
	const editor = vscode.window.activeTextEditor
	if (!editor) {
		void vscode.window.showWarningMessage("Forge: open a file and select the code you want to edit.")
		return
	}
	const selection = editor.selection
	if (selection.isEmpty) {
		void vscode.window.showWarningMessage("Forge: select the code you want to change first.")
		return
	}
	const instruction = await vscode.window.showInputBox({
		title: "Forge inline edit",
		prompt: "Describe the change in plain language",
		placeHolder: "e.g. treat 'off' and 'n' as false, case-insensitively, and update the docstring",
		ignoreFocusOut: true,
	})
	if (!instruction?.trim()) {
		return
	}

	const document = editor.document
	const path = vscode.workspace.asRelativePath(document.uri, false)
	const request: InlineEditRequest = {
		path,
		content: document.getText(),
		startLine: selection.start.line + 1,
		endLine: selection.end.line + 1,
		instruction: instruction.trim(),
	}

	let plan: ReturnType<typeof planInlineEdit>
	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: "Forge is thinking…", cancellable: false },
			async () => {
				const reply = await runInlineTurn(buildInlineEditPrompt(request), context.extensionPath)
				plan = planInlineEdit(request, reply)
			},
		)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		Logger.error(`[Forge] inline edit failed: ${message}`)
		void vscode.window.showErrorMessage(`Forge: ${message}`)
		return
	}

	if (!plan!.hunks.length) {
		void vscode.window.showInformationMessage("Forge: the model proposed no change for that instruction.")
		return
	}
	if (plan!.rejected.length) {
		void vscode.window.showWarningMessage(
			`Forge: ${plan!.rejected.length} hunk(s) did not match the file and were dropped: ${plan!.rejected
				.map((r) => `#${r.hunk + 1} ${r.reason}`)
				.join("; ")}`,
		)
	}

	const decision = await reviewHunks(request, plan!)
	if (!decision) {
		return
	}
	const outcome = applyAcceptedHunks(request.content, plan!.hunks, decision.accepted)
	if (outcome.applied === 0) {
		void vscode.window.showInformationMessage("Forge: all hunks rejected; the file is unchanged.")
		return
	}

	// Write through the editor so undo works and the buffer stays in sync.
	const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(request.content.length))
	const edit = new vscode.WorkspaceEdit()
	edit.replace(document.uri, fullRange, outcome.content)
	const applied = await vscode.workspace.applyEdit(edit)
	if (!applied) {
		void vscode.window.showErrorMessage("Forge: the editor refused the edit; the file is unchanged.")
		return
	}
	await document.save()

	undoStack.push({ path, before: request.content, after: outcome.content, at: Date.now() })
	Logger.log(`[Forge] inline edit applied ${outcome.applied} hunk(s) to ${path}`)
	void vscode.window.showInformationMessage(
		`Forge: applied ${outcome.applied} hunk${outcome.applied === 1 ? "" : "s"} to ${path}. Undo with "Forge: Undo Last Edit".`,
	)
}

/** Restore the exact pre-edit bytes of the most recent inline edit. */
export async function undoLastInlineEdit(): Promise<void> {
	const entry = undoStack.pop()
	if (!entry) {
		void vscode.window.showInformationMessage("Forge: no inline edit to undo.")
		return
	}
	const root = vscode.workspace.workspaceFolders?.[0]?.uri
	if (!root) {
		void vscode.window.showErrorMessage("Forge: no workspace folder open.")
		return
	}
	const uri = vscode.Uri.joinPath(root, entry.path)
	const document = await vscode.workspace.openTextDocument(uri)
	const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length))
	const edit = new vscode.WorkspaceEdit()
	edit.replace(uri, fullRange, entry.before)
	const applied = await vscode.workspace.applyEdit(edit)
	if (!applied) {
		void vscode.window.showErrorMessage("Forge: could not undo; the file was not restored.")
		return
	}
	await document.save()
	void vscode.window.showInformationMessage(`Forge: restored ${entry.path} to its pre-edit content.`)
}

/** Test seam: read the undo stack length without exposing the stack itself. */
export function inlineUndoDepth(): number {
	return undoStack.length
}

/** Test seam: write bytes directly, used by the approval-roundtrip gate. */
export function writeBytesForTest(path: string, content: string): void {
	writeFileSync(path, content, "utf8")
}

export type { EditHunk }
