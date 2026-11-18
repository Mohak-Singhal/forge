/**
 * Inline edit — pure core (no `vscode` imports, so it unit-tests in plain Node).
 *
 * The user selects a region, presses a keybinding, types an instruction. We build a
 * prompt that pins the model to that region, ask TrueForge for exact-hunk edits as
 * JSON, parse them defensively, and hand the hunks to the diff review UI. Nothing
 * here touches disk: applying is a separate, user-approved step.
 */

import { applyHunks, type EditHunk } from "./edits"

export interface InlineEditRequest {
	/** Workspace-relative path, for display and for the prompt. */
	path: string
	/** Full current file content. */
	content: string
	/** 1-based inclusive selection range. */
	startLine: number
	endLine: number
	/** The user's plain-language instruction. */
	instruction: string
}

export interface InlineEditPlan {
	/** Hunks the model proposed, in order. */
	hunks: EditHunk[]
	/** Full proposed file content after applying every hunk. */
	proposed: string
	/** Hunks the model proposed that could not be applied (stale/ambiguous). */
	rejected: Array<{ hunk: number; reason: string }>
}

/** The selected region as text, with 1-based line numbers preserved for the prompt. */
export function selectedRegion(request: InlineEditRequest): string {
	const lines = request.content.split("\n")
	const start = Math.max(1, Math.min(request.startLine, lines.length))
	const end = Math.max(start, Math.min(request.endLine, lines.length))
	return lines.slice(start - 1, end).join("\n")
}

/**
 * Prompt for the inline-edit turn. Deliberately narrow: the model must return hunks
 * that match the file byte-for-byte, because `applyHunks` refuses ambiguous matches
 * rather than guessing. The JSON-only contract keeps parsing deterministic.
 */
export function buildInlineEditPrompt(request: InlineEditRequest): string {
	const region = selectedRegion(request)
	return [
		`You are editing a single region of ${request.path}.`,
		`The selected region is lines ${request.startLine}-${request.endLine}:`,
		"```",
		region,
		"```",
		"",
		`Instruction: ${request.instruction}`,
		"",
		"Reply with ONLY a JSON object, no prose and no code fences:",
		'{"edits":[{"oldText":"...","newText":"...","intent":"..."}]}',
		"",
		"Rules:",
		"- `oldText` must be copied exactly from the file, including indentation, and must occur exactly once in the file.",
		"- `newText` is the replacement for that exact span.",
		"- Keep every hunk inside the selected region unless the instruction requires otherwise.",
		"- Prefer the fewest hunks that satisfy the instruction.",
		'- If the instruction needs no change, reply {"edits":[]}.',
	].join("\n")
}

/** Pull the first JSON object out of a model reply, tolerating fences and stray prose. */
export function extractJsonObject(reply: string): unknown {
	const trimmed = reply.trim()
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
	const candidate = fenced ? fenced[1].trim() : trimmed
	try {
		return JSON.parse(candidate)
	} catch {
		// Fall back to the outermost brace span (models like to add a sentence after).
		const start = candidate.indexOf("{")
		const end = candidate.lastIndexOf("}")
		if (start === -1 || end === -1 || end <= start) {
			throw new Error("inline edit: model reply contained no JSON object")
		}
		return JSON.parse(candidate.slice(start, end + 1))
	}
}

/** Parse a model reply into hunks. Throws only when the reply is unusable. */
export function parseInlineEditReply(reply: string): EditHunk[] {
	const parsed = extractJsonObject(reply) as { edits?: unknown }
	const raw = Array.isArray(parsed?.edits) ? parsed.edits : []
	const hunks: EditHunk[] = []
	for (const [index, edit] of raw.entries()) {
		const candidate = edit as Record<string, unknown>
		if (typeof candidate?.oldText !== "string" || typeof candidate?.newText !== "string") {
			throw new Error(`inline edit: edit ${index} is missing oldText/newText strings`)
		}
		hunks.push({
			oldText: candidate.oldText,
			newText: candidate.newText,
			intent: typeof candidate.intent === "string" ? candidate.intent : undefined,
		})
	}
	return hunks
}

/**
 * Turn a model reply into an applicable plan. A hunk that does not match the file
 * exactly is reported, not silently dropped — the review UI shows it as rejected so
 * the user sees the model was wrong rather than thinking the edit was clean.
 */
export function planInlineEdit(request: InlineEditRequest, reply: string): InlineEditPlan {
	const hunks = parseInlineEditReply(reply)
	if (hunks.length === 0) {
		return { hunks: [], proposed: request.content, rejected: [] }
	}
	const result = applyHunks(request.content, hunks)
	if (result.proposed !== undefined) {
		return { hunks, proposed: result.proposed, rejected: [] }
	}
	// Some hunks failed: apply the ones that do work so the preview is still useful,
	// and surface the rest as rejected.
	const good = hunks.filter((_, index) => !result.rejected.some((r) => r.hunk === index))
	const partial = applyHunks(request.content, good)
	return {
		hunks,
		proposed: partial.proposed ?? request.content,
		rejected: result.rejected,
	}
}

/**
 * Apply only the hunks the user accepted. Returns the new content plus what was
 * skipped, so the caller can report a partial acceptance honestly.
 */
export function applyAcceptedHunks(
	content: string,
	hunks: EditHunk[],
	accepted: boolean[],
): { content: string; applied: number; rejected: Array<{ hunk: number; reason: string }> } {
	const chosen = hunks.filter((_, index) => accepted[index] === true)
	if (chosen.length === 0) {
		return { content, applied: 0, rejected: [] }
	}
	const result = applyHunks(content, chosen)
	return {
		content: result.proposed ?? content,
		applied: result.applied,
		rejected: result.rejected,
	}
}
