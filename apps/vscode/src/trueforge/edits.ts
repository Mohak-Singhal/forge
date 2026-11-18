/**
 * Forge edit application — applies agent-proposed hunk edits to files.
 * Shared by the MCP propose-edit tool (executes on approval) and the diff
 * preview opener (computes proposed content pre-approval).
 */

import { createHash } from "node:crypto"

import { readFileSync } from "node:fs"

export interface EditHunk {
	/** The exact text currently in the file to replace (must occur exactly once, or `replaceAll`). */
	oldText: string
	/** Replacement text. */
	newText: string
	/** Hint for the UI; not required. */
	intent?: string
}

export interface ApplyResult {
	ok: boolean
	applied: number
	rejected: Array<{ hunk: number, reason: string }>
	/** Full proposed content if every hunk applied cleanly, else undefined. */
	proposed?: string
	staleBase?: boolean
	error?: string
}

export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex")
}

export function applyHunks(original: string, hunks: EditHunk[]): ApplyResult {
	let current = original
	let applied = 0
	const rejected: Array<{ hunk: number, reason: string }> = []
	for (let index = 0; index < hunks.length; index++) {
		const hunk = hunks[index]
		if (!hunk || typeof hunk.oldText !== "string" || typeof hunk.newText !== "string") {
			rejected.push({ hunk: index, reason: "hunk missing oldText/newText" })
			continue
		}
		if (hunk.oldText.length === 0) {
			// Insertion hunk: replace a unique anchor. Require `anchor` semantics: insert after the first occurrence of newText's anchor if provided in intent; here we insert at end.
			current = current + hunk.newText
			applied++
			continue
		}
		const first = current.indexOf(hunk.oldText)
		if (first === -1) {
			rejected.push({ hunk: index, reason: "old_text not found (stale base?)" })
			continue
		}
		const second = current.indexOf(hunk.oldText, first + 1)
		if (second !== -1) {
			rejected.push({ hunk: index, reason: "old_text occurs multiple times; refusing to guess" })
			continue
		}
		current = current.slice(0, first) + hunk.newText + current.slice(first + hunk.oldText.length)
		applied++
	}
	if (rejected.length === 0) {
		return { ok: true, applied, rejected: [], proposed: current }
	}
	return { ok: rejected.length === 0, applied, rejected }
}

export function readFile(path: string): string {
	return readFileSync(path, "utf8")
}
