/**
 * Hunk review registry — carries the user's per-hunk decisions from the review UI to
 * the tool that applies them.
 *
 * TrueForge pauses a turn at `tool.approval_required` and only runs the MCP tool once
 * the user approves. Approval itself is binary, so per-hunk choice needs somewhere to
 * live between the two steps: the review UI records which hunks the user accepted,
 * and `editor_propose_edit` applies exactly those. Nothing is written before approval,
 * and a hunk the user unticked is never applied even though the tool call was allowed.
 *
 * The key is the proposal's content identity (path + hunks), not the tool-call id,
 * because the MCP handler never sees the harness-side tool-call id.
 */

import { createHash } from "node:crypto"
import type { EditHunk } from "./edits"

const decisions = new Map<string, boolean[]>()

/** Stable identity for a proposal: same path and same hunks ⇒ same key. */
export function proposalKey(path: string, hunks: EditHunk[]): string {
	const normalised = hunks.map((hunk) => ({ o: hunk.oldText, n: hunk.newText }))
	return createHash("sha256")
		.update(JSON.stringify({ path, hunks: normalised }), "utf8")
		.digest("hex")
}

export function recordHunkDecisions(key: string, accepted: boolean[]): void {
	decisions.set(key, accepted)
	// Bound the map: a review that is never consumed (turn cancelled) must not leak.
	if (decisions.size > 50) {
		const oldest = decisions.keys().next().value
		if (oldest !== undefined) {
			decisions.delete(oldest)
		}
	}
}

/**
 * Consume the decisions for a proposal. Absent decisions (auto-approved tool, headless
 * run, review UI unavailable) mean "all accepted", which matches the harness approval
 * the user already gave.
 */
export function takeHunkDecisions(key: string, hunkCount: number): boolean[] {
	const stored = decisions.get(key)
	decisions.delete(key)
	if (!stored || stored.length !== hunkCount) {
		return Array.from({ length: hunkCount }, () => true)
	}
	return stored
}

/** Test seam. */
export function clearHunkDecisions(): void {
	decisions.clear()
}

/** Test seam. */
export function pendingDecisionCount(): number {
	return decisions.size
}
