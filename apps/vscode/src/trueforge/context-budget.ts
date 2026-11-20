/**
 * Context budget — pure core (no `vscode`/`fs` imports, so it unit-tests in plain Node).
 *
 * The retrieval layer ranks chunks with BM25. Ranking alone is not a strategy: a
 * 17k-line repository produces far more relevant-looking chunks than any context
 * window can hold, and whatever we send is taken away from the conversation. So the
 * second half of retrieval is *eviction*: pack the ranked list into a fixed token
 * budget, prefer many small high-signal chunks over one giant file, and record for
 * every chunk either the budget it consumed or the reason it was dropped.
 *
 * The report is what the agent sees. It states the budget, what was spent, and why
 * each chunk was chosen (matched terms, definition boost, filename hit) — that is
 * how a user can tell a retrieval that worked from one that got lucky.
 */

/** A retrieval candidate, as produced by the BM25 ranker. */
export interface ContextCandidate {
	path: string
	startLine: number
	endLine: number
	score: number
	text: string
	/** Query terms this chunk actually contains, strongest first. */
	matchedTerms?: string[]
	/**
	 * Factual note about why this chunk was added beyond BM25 (for example
	 * "links to FlaskGroup"). Shown in the agent-visible reason line.
	 */
	why?: string
}

export interface ContextBudgetOptions {
	/** Hard ceiling for the packed text, in estimated tokens. */
	budgetTokens?: number
	/** Never return more than this many chunks, whatever the budget allows. */
	maxChunks?: number
	/** A single chunk larger than this is truncated rather than dropped. */
	maxChunkTokens?: number
	/** Extra first line for the report (e.g. the query and detected intent). */
	header?: string
	/** Candidates the selector ranked before it chose these chunks (for honest reporting). */
	selectedFrom?: number
}

export interface PackedChunk {
	path: string
	startLine: number
	endLine: number
	score: number
	text: string
	/** Estimated tokens this chunk costs after truncation. */
	tokens: number
	/** One line the agent can read: why this chunk is in the context. */
	reason: string
	/** True when the chunk body was cut to fit `maxChunkTokens`. */
	truncated: boolean
}

export interface DroppedChunk {
	path: string
	startLine: number
	endLine: number
	score: number
	tokens: number
	reason: string
}

export interface PackedContext {
	chunks: PackedChunk[]
	dropped: DroppedChunk[]
	budgetTokens: number
	usedTokens: number
	/** Candidate count before packing. */
	considered: number
	/** Markdown-ready summary of the budget and every decision taken. */
	report: string
}

const DEFAULT_BUDGET_TOKENS = 4000
const DEFAULT_MAX_CHUNKS = 8
const DEFAULT_MAX_CHUNK_TOKENS = 900

/**
 * Token estimate. Deliberately conservative (~3.6 chars/token) because the cost of
 * over-running a budget is a truncated tool result; the cost of under-running it is
 * a few unused tokens.
 */
export function estimateTokens(text: string): number {
	if (!text) {
		return 0
	}
	return Math.ceil(text.length / 3.6)
}

/** Cut text to a token ceiling, on a line boundary when one is nearby. */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
	if (maxTokens <= 0) {
		return { text: "", truncated: text.length > 0 }
	}
	if (estimateTokens(text) <= maxTokens) {
		return { text, truncated: false }
	}
	const maxChars = Math.floor(maxTokens * 3.6)
	const slice = text.slice(0, maxChars)
	const lastNewline = slice.lastIndexOf("\n")
	const body = lastNewline > maxChars * 0.6 ? slice.slice(0, lastNewline) : slice
	return { text: `${body}\n…[truncated to fit the context budget]`, truncated: true }
}

function describeReason(candidate: ContextCandidate, tokens: number, truncated: boolean): string {
	const parts: string[] = []
	if (candidate.why) {
		parts.push(candidate.why)
	}
	const terms = (candidate.matchedTerms ?? []).filter(Boolean).slice(0, 4)
	if (terms.length > 0) {
		parts.push(`matches ${terms.map((t) => `"${t}"`).join(", ")}`)
	}
	parts.push(`BM25 ${candidate.score.toFixed(2)}`)
	parts.push(`lines ${candidate.startLine}-${candidate.endLine}`)
	parts.push(`${tokens} tok`)
	if (truncated) {
		parts.push("truncated to budget")
	}
	return parts.join(" · ")
}

/**
 * Pack ranked candidates into a token budget.
 *
 * Order of preference: score first (the ranker's opinion), but a chunk that would
 * consume the entire remaining budget is compressed to `maxChunkTokens` so that one
 * large file cannot evict five small precise ones — the failure mode that makes
 * retrieval useless in practice.
 */
export function packContext(candidates: ContextCandidate[], options: ContextBudgetOptions = {}): PackedContext {
	const budgetTokens = Math.max(1, Math.floor(options.budgetTokens ?? DEFAULT_BUDGET_TOKENS))
	const maxChunks = Math.max(1, Math.floor(options.maxChunks ?? DEFAULT_MAX_CHUNKS))
	const maxChunkTokens = Math.max(1, Math.floor(options.maxChunkTokens ?? DEFAULT_MAX_CHUNK_TOKENS))

	const chunks: PackedChunk[] = []
	const dropped: DroppedChunk[] = []
	let used = 0

	const ranked = [...candidates].sort((a, b) => b.score - a.score)

	for (const candidate of ranked) {
		const rawTokens = estimateTokens(candidate.text)
		if (chunks.length >= maxChunks) {
			dropped.push({
				path: candidate.path,
				startLine: candidate.startLine,
				endLine: candidate.endLine,
				score: candidate.score,
				tokens: rawTokens,
				reason: `chunk cap reached (${maxChunks} chunks already packed)`,
			})
			continue
		}
		const remaining = budgetTokens - used
		if (remaining <= 0) {
			dropped.push({
				path: candidate.path,
				startLine: candidate.startLine,
				endLine: candidate.endLine,
				score: candidate.score,
				tokens: rawTokens,
				reason: `budget exhausted (${used}/${budgetTokens} tokens used)`,
			})
			continue
		}

		// Prefer a compressed chunk over no chunk when this one is oversized.
		let body = candidate.text
		let truncated = false
		if (rawTokens > remaining || rawTokens > maxChunkTokens) {
			const ceiling = Math.min(remaining, maxChunkTokens)
			const cut = truncateToTokens(candidate.text, ceiling)
			body = cut.text
			truncated = cut.truncated
		}
		const tokens = estimateTokens(body)
		if (tokens <= 0) {
			dropped.push({
				path: candidate.path,
				startLine: candidate.startLine,
				endLine: candidate.endLine,
				score: candidate.score,
				tokens: 0,
				reason: "empty after truncation",
			})
			continue
		}
		if (tokens > remaining) {
			dropped.push({
				path: candidate.path,
				startLine: candidate.startLine,
				endLine: candidate.endLine,
				score: candidate.score,
				tokens,
				reason: `does not fit the remaining ${remaining} tokens`,
			})
			continue
		}

		used += tokens
		chunks.push({
			path: candidate.path,
			startLine: candidate.startLine,
			endLine: candidate.endLine,
			score: candidate.score,
			text: body,
			tokens,
			reason: describeReason(candidate, tokens, truncated),
			truncated,
		})
	}

	const reportLines: string[] = []
	if (options.header) {
		reportLines.push(options.header)
	}
	const source = options.selectedFrom ?? ranked.length
	reportLines.push(
		`retrieval budget: ${used}/${budgetTokens} tokens across ${chunks.length} chunk(s), selected from ${source} candidate(s)`,
	)
	if (dropped.length > 0) {
		reportLines.push(`dropped ${dropped.length} candidate(s) to stay inside the budget:`)
		for (const item of dropped.slice(0, 6)) {
			reportLines.push(`- ${item.path}:${item.startLine}-${item.endLine} — ${item.reason}`)
		}
		if (dropped.length > 6) {
			reportLines.push(`- …and ${dropped.length - 6} more`)
		}
	}

	return {
		chunks,
		dropped,
		budgetTokens,
		usedTokens: used,
		considered: ranked.length,
		report: reportLines.join("\n"),
	}
}

/** Render a packed context as the text an `editor_retrieve` tool result returns. */
export function formatPackedContext(context: PackedContext): string {
	if (context.chunks.length === 0) {
		return `${context.report}\n\nno chunks matched`
	}
	const sections = context.chunks.map(
		(chunk) => `## ${chunk.path}:${chunk.startLine}-${chunk.endLine} (${chunk.reason})\n${chunk.text}`,
	)
	return `${context.report}\n\n${sections.join("\n\n---\n\n")}`
}
