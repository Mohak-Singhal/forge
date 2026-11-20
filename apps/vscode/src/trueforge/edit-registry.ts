/**
 * Edit registry — holds staged hunk proposals waiting for user review.
 *
 * The TrueForge agent stages edits via `editor_propose_edit`. Nothing is written until
 * the user approves the diff in the editor UI and the extension (or `editor_apply_staged`)
 * asks the registry to commit. Undo restores from snapshots.
 */

export interface StagedHunk {
	/** Which proposal this hunk belongs to (the propose_edit call id). */
	proposalId: string
	path: string
	/** 0-based hunk index within the proposal. */
	index: number
	/** Line range in the original file (inclusive). */
	startLine: number
	endLine: number
	/** The proposed replacement text for that range. */
	newText: string
	/** The text being replaced (for context/undo sanity). */
	oldText: string
}

export interface EditProposal {
	id: string
	summary: string
	createdAt: number
	status: "pending" | "applied" | "rejected" | "partially_applied"
	hunks: StagedHunk[]
}

class EditRegistry {
	private proposals = new Map<string, EditProposal>()

	stage(proposalId: string, summary: string, hunks: Array<Omit<StagedHunk, "proposalId" | "index">>): EditProposal {
		const staged = hunks.map((h, index) => ({ ...h, proposalId, index }))
		const proposal: EditProposal = {
			id: proposalId,
			summary,
			createdAt: Date.now(),
			status: "pending",
			hunks: staged,
		}
		this.proposals.set(proposalId, proposal)
		return proposal
	}

	get(id: string): EditProposal | undefined {
		return this.proposals.get(id)
	}

	listPending(): EditProposal[] {
		return [...this.proposals.values()].filter((p) => p.status === "pending")
	}

	markApplied(id: string, applied: number): void {
		const p = this.proposals.get(id)
		if (p) {
			p.status = applied === p.hunks.length ? "applied" : applied > 0 ? "partially_applied" : "rejected"
		}
	}

	markRejected(id: string): void {
		const p = this.proposals.get(id)
		if (p) {
			p.status = "rejected"
		}
	}
}

export const editRegistry = new EditRegistry()
