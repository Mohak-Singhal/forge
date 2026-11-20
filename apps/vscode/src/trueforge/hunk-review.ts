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
 *
 * Fail-closed contract: a proposal with no recorded review is NOT implicitly accepted.
 * `takeHunkDecisions` reports `unreviewed` and the write path refuses. The only way to
 * write without a review is the explicit headless seam (`allowUnreviewedEdits`), which
 * exists for automated tests and is never set by the extension.
 */

import { createHash } from "node:crypto"
import type { EditHunk } from "./edits"

interface RecordedReview {
	accepted: boolean[]
	/** Harness tool-call id this review was collected for, when known. */
	toolCallId?: string
}

const decisions = new Map<string, RecordedReview>()
/** toolCallId → proposalKey, so a denied approval can drop the review it produced. */
const byToolCall = new Map<string, string>()

/**
 * Headless seam. Automated tests that exercise the apply path without a UI set this
 * explicitly. The extension never sets it, so an interactive edit can never reach the
 * write path without a recorded review.
 */
let unreviewedWritesAllowed = false

export function allowUnreviewedEdits(allowed: boolean): void {
	unreviewedWritesAllowed = allowed
}

export function isUnreviewedWriteAllowed(): boolean {
	return unreviewedWritesAllowed
}

/** Stable identity for a proposal: same path and same hunks ⇒ same key. */
export function proposalKey(path: string, hunks: EditHunk[]): string {
	const normalised = hunks.map((hunk) => ({ o: hunk.oldText, n: hunk.newText }))
	return createHash("sha256")
		.update(JSON.stringify({ path, hunks: normalised }), "utf8")
		.digest("hex")
}

export function recordHunkDecisions(key: string, accepted: boolean[], toolCallId?: string): void {
	decisions.set(key, { accepted, toolCallId })
	if (toolCallId) {
		byToolCall.set(toolCallId, key)
	}
	// Bound the map: a review that is never consumed (turn cancelled) must not leak.
	if (decisions.size > 50) {
		const oldest = decisions.keys().next().value
		if (oldest !== undefined) {
			dropKey(oldest)
		}
	}
}

/** Remove every trace of a proposal's review. */
function dropKey(key: string): void {
	const recorded = decisions.get(key)
	decisions.delete(key)
	if (recorded?.toolCallId) {
		byToolCall.delete(recorded.toolCallId)
	}
}

/**
 * Drop the review collected for a specific tool call. Called when the user denies the
 * tool approval: the review must not survive to be consumed by a later proposal of the
 * same shape, which would apply hunks the user never approved for that call.
 */
export function clearHunkDecisionForToolCall(toolCallId: string): void {
	const key = byToolCall.get(toolCallId)
	if (key === undefined) {
		return
	}
	dropKey(key)
}

/** Drop a review by proposal key (used when a review could not be shown). */
export function clearHunkDecision(key: string): void {
	dropKey(key)
}

/**
 * The outcome of looking up a proposal's review. `unreviewed` is distinct from
 * "reviewed and everything rejected" so the caller can fail closed on the former and
 * report honestly on the latter.
 */
export type HunkDecision = { kind: "reviewed"; accepted: boolean[] } | { kind: "unreviewed"; reason: string }

/**
 * Consume the decisions for a proposal. Absent decisions mean the review never ran —
 * the caller must not treat that as consent. A recording whose length does not match
 * the proposal is also unreviewed: it belongs to a different proposal shape.
 */
export function takeHunkDecisions(key: string, hunkCount: number): HunkDecision {
	const stored = decisions.get(key)
	dropKey(key)
	if (!stored) {
		return { kind: "unreviewed", reason: "no hunk review was recorded for this proposal" }
	}
	if (stored.accepted.length !== hunkCount) {
		return {
			kind: "unreviewed",
			reason: `recorded review covers ${stored.accepted.length} hunk(s) but the proposal has ${hunkCount}`,
		}
	}
	return { kind: "reviewed", accepted: stored.accepted }
}

/** Test seam. */
export function clearHunkDecisions(): void {
	decisions.clear()
	byToolCall.clear()
}

/** Test seam. */
export function pendingDecisionCount(): number {
	return decisions.size
}
