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
	rejected: Array<{ hunk: number; reason: string }>
	/** Full proposed content if every hunk applied cleanly, else undefined. */
	proposed?: string
	staleBase?: boolean
	error?: string
}

export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex")
}

/**
 * Occurrences of `needle` that do not cut an identifier in half.
 *
 * A plain `indexOf` match turns `VALUE = 1` into a match inside `VALUE = 10`, and
 * `return val` into a match inside `return value`. Models copy exact text, but a stale
 * base or a sloppy hunk would then edit the wrong token. A match is safe when it does
 * not start or end in the middle of an identifier; punctuation boundaries (`(`, `,`,
 * `"`) stay allowed so partial-expression hunks still work.
 */
function safeOccurrences(haystack: string, needle: string): number[] {
	const found: number[] = []
	const startsIdent = /[A-Za-z0-9_]/.test(needle[0] ?? "")
	const endsIdent = /[A-Za-z0-9_]/.test(needle[needle.length - 1] ?? "")
	let from = 0
	while (from <= haystack.length) {
		const index = haystack.indexOf(needle, from)
		if (index === -1) {
			break
		}
		const before = index > 0 ? haystack[index - 1] : ""
		const after = index + needle.length < haystack.length ? haystack[index + needle.length] : ""
		const cutsLeft = startsIdent && /[A-Za-z0-9_]/.test(before)
		const cutsRight = endsIdent && /[A-Za-z0-9_]/.test(after)
		if (!cutsLeft && !cutsRight) {
			found.push(index)
		}
		from = index + 1
	}
	return found
}

export function applyHunks(original: string, hunks: EditHunk[]): ApplyResult {
	let current = original
	let applied = 0
	const rejected: Array<{ hunk: number; reason: string }> = []
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
		const occurrences = safeOccurrences(current, hunk.oldText)
		if (occurrences.length === 0) {
			rejected.push({ hunk: index, reason: "old_text not found (stale base?)" })
			continue
		}
		if (occurrences.length > 1) {
			rejected.push({ hunk: index, reason: "old_text occurs multiple times; refusing to guess" })
			continue
		}
		const first = occurrences[0]
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
