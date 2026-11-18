/**
 * Forge hunk review — the diff the user actually looks at before an MCP edit lands.
 *
 * Without this, a Forge edit reaches the user as a bare Approve button and the change
 * itself is invisible until after it is on disk — which defeats the point of review.
 * So when TrueForge pauses `editor_propose_edit` for approval, this module opens a
 * real `vscode.diff` tab (original ↔ proposed), then asks per hunk which to keep.
 *
 * Approve in the chat means "the agent may apply"; the per-hunk answers here mean
 * "apply exactly these". Both are needed: the harness owns the pause, and only this
 * layer knows which hunks the human ticked. The answers are handed to the tool
 * through `hunk-review`, so a rejected hunk is never written even though the tool
 * call was approved.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { applyHunks, type EditHunk } from "@/trueforge/edits"
import { proposalKey, recordHunkDecisions } from "@/trueforge/hunk-review"
import { EDIT_PREVIEW_URI_SCHEME, editPreviewContentProvider } from "./VscodeEditPreview"

let previewCounter = 0

export interface ForgeProposalInput {
	path?: unknown
	summary?: unknown
	edits?: unknown
}

function coerceHunks(input: ForgeProposalInput): EditHunk[] {
	const edits = Array.isArray(input.edits) ? input.edits : []
	const hunks: EditHunk[] = []
	for (const edit of edits) {
		const candidate = edit as Record<string, unknown>
		if (typeof candidate?.oldText === "string" && typeof candidate?.newText === "string") {
			hunks.push({
				oldText: candidate.oldText,
				newText: candidate.newText,
				intent: typeof candidate.intent === "string" ? candidate.intent : undefined,
			})
		}
	}
	return hunks
}

/**
 * Apply whichever hunks still match, so the preview shows the change the agent meant
 * even when one hunk drifted. Never used for the write path — the tool applies its own
 * atomic result — only to render an honest preview.
 */
function applyBestEffort(original: string, hunks: EditHunk[]): string {
	let current = original
	for (const hunk of hunks) {
		if (!hunk || hunk.oldText.length === 0) {
			continue
		}
		const first = current.indexOf(hunk.oldText)
		if (first === -1) {
			continue
		}
		if (current.indexOf(hunk.oldText, first + 1) !== -1) {
			continue
		}
		current = current.slice(0, first) + hunk.newText + current.slice(first + hunk.oldText.length)
	}
	return current
}

/** True when this tool call is one of Forge's MCP edit tools. */
export function isForgeEditTool(toolName: string): boolean {
	const base = toolName.includes("__") ? toolName.slice(toolName.lastIndexOf("__") + 2) : toolName
	return base === "editor_propose_edit"
}

/**
 * Open the diff for a proposed edit and collect per-hunk decisions. Returns undefined
 * when the review could not be shown (missing file, nothing to diff) so the caller
 * falls back to the plain approval the harness already asked for.
 */
export async function reviewForgeProposal(
	toolName: string,
	input: unknown,
	cwd: string,
): Promise<{ accepted: boolean[] } | undefined> {
	if (!isForgeEditTool(toolName)) {
		return undefined
	}
	const proposal = (input ?? {}) as ForgeProposalInput
	if (typeof proposal.path !== "string" || !proposal.path.trim()) {
		return undefined
	}
	const hunks = coerceHunks(proposal)
	if (hunks.length === 0) {
		return undefined
	}

	const absolutePath = resolve(cwd, proposal.path)
	let original = ""
	try {
		original = readFileSync(absolutePath, "utf8")
	} catch {
		// New file: diff against empty content.
		original = ""
	}
	const result = applyHunks(original, hunks)
	// applyHunks is atomic: it only returns `proposed` when every hunk landed. For the
	// preview we still want a diff when some hunks are stale, so apply what we can and
	// note the rest — showing nothing would look like the agent proposed no change.
	const proposed = result.proposed ?? applyBestEffort(original, hunks)
	const key = proposalKey(proposal.path, hunks)
	const summary = typeof proposal.summary === "string" ? proposal.summary : "proposed change"

	const previewId = previewCounter++
	const leftUri = vscode.Uri.parse(`${EDIT_PREVIEW_URI_SCHEME}:${proposal.path}`).with({ query: `forge-${previewId}-left` })
	const rightUri = vscode.Uri.parse(`${EDIT_PREVIEW_URI_SCHEME}:${proposal.path}`).with({ query: `forge-${previewId}-right` })
	editPreviewContentProvider.set(leftUri, original)
	editPreviewContentProvider.set(rightUri, proposed)

	const title = `${proposal.path}: ${hunks.length} hunk${hunks.length === 1 ? "" : "s"} (Forge review)`
	try {
		await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title, {
			preview: false,
			preserveFocus: true,
		})
	} catch (error) {
		Logger.warn(`[Forge] could not open diff preview: ${error}`)
		editPreviewContentProvider.delete(leftUri)
		editPreviewContentProvider.delete(rightUri)
		return undefined
	}

	try {
		const accepted: boolean[] = []
		for (const [index, hunk] of hunks.entries()) {
			const body = hunk.newText.length > 500 ? `${hunk.newText.slice(0, 500)}…` : hunk.newText
			const label = `Hunk ${index + 1}/${hunks.length}${hunk.intent ? ` — ${hunk.intent}` : ""}`
			const choice = await vscode.window.showInformationMessage(
				`${summary}\n\n${label}\n\n${body}`,
				{ modal: true },
				"Keep Hunk",
				"Skip Hunk",
			)
			if (choice === undefined) {
				// Dismissed: stop asking, keep what was already accepted, skip the rest.
				for (let rest = index; rest < hunks.length; rest++) {
					accepted.push(false)
				}
				break
			}
			accepted.push(choice === "Keep Hunk")
		}
		// Hand the decisions to the MCP tool, which runs after the harness approval.
		recordHunkDecisions(key, accepted)
		const kept = accepted.filter(Boolean).length
		if (kept === 0) {
			void vscode.window.showWarningMessage("Forge: you skipped every hunk. Reject the edit in the chat to stop it.")
		}
		return { accepted }
	} finally {
		// Keep the content until the tool has run; the provider is bounded and the
		// entries are small. Closing the tab is enough to leave the review.
		Logger.log(`[Forge] hunk review finished for ${proposal.path}`)
	}
}

/** Test seam: expose the coercion so the input shape is pinned by a unit test. */
export function coerceHunksForTest(input: ForgeProposalInput): EditHunk[] {
	return coerceHunks(input)
}
