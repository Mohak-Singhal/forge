/**
 * Mentions — pure core for `@file` and `@symbol` context injection.
 *
 * The user can pin context explicitly: `@src/flask/cli.py` pulls that file in,
 * `@FlaskGroup` pulls in the definition of that symbol wherever it lives. Explicit
 * mentions are ground truth — they are resolved before the agent reads anything and
 * are never evicted by retrieval, because a user pointing at a file is a stronger
 * signal than any ranking function.
 *
 * Parsing lives here (no `fs`, no `vscode`) so the behaviour is unit-tested; the
 * resolution step that touches the workspace lives in the MCP tool layer.
 */

export interface ParsedMentions {
	/** Workspace-relative paths the user named. */
	files: string[]
	/** Symbol names the user named. */
	symbols: string[]
	/** The prompt with mention tokens removed, for the model's own reading. */
	text: string
}

/**
 * Mention syntax:
 *   `@src/flask/cli.py`            → file (contains a slash or a file extension)
 *   `@tests/test_cli.py:40-80`     → file with a line range
 *   `@FlaskGroup`                  → symbol (bare identifier)
 *
 * A trailing `@` that is not followed by an identifier is left alone (email
 * addresses, decorators in code samples and `@{...}` templates all survive).
 */
export function parseMentions(prompt: string): ParsedMentions {
	const files: string[] = []
	const symbols: string[] = []
	const mentionPattern = /(^|\s)@([A-Za-z0-9_./-]+)/g
	const text = prompt.replace(mentionPattern, (match, lead: string, token: string) => {
		const cleaned = token.replace(/[.,;:)\]]+$/, "")
		if (!cleaned) {
			return match
		}
		const looksLikePath = cleaned.includes("/") || cleaned.includes("\\") || /\.[A-Za-z0-9]{1,8}(:\d+(-\d+)?)?$/.test(cleaned)
		if (looksLikePath) {
			const withoutRange = cleaned.replace(/:\d+(-\d+)?$/, "")
			if (!files.includes(withoutRange)) {
				files.push(withoutRange)
			}
		} else if (!symbols.includes(cleaned)) {
			symbols.push(cleaned)
		}
		return lead
	})
	return {
		files,
		symbols,
		text: text.replace(/[ \t]{2,}/g, " ").trim(),
	}
}

/** True when the prompt pins anything explicitly. */
export function hasMentions(mentions: ParsedMentions): boolean {
	return mentions.files.length > 0 || mentions.symbols.length > 0
}

/**
 * Split a `path:start-end` mention into its parts. Ranges let a user point at one
 * function in a 1,100-line file without spending the whole budget on the file.
 */
export function parseMentionRange(raw: string): { path: string; startLine?: number; endLine?: number } {
	const match = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(raw.trim())
	if (!match) {
		return { path: raw.trim() }
	}
	const path = (match[1] ?? raw).trim()
	const startLine = match[2] ? Number.parseInt(match[2], 10) : undefined
	const endLine = match[3] ? Number.parseInt(match[3], 10) : undefined
	return { path, startLine, endLine }
}

/**
 * Which known paths satisfy a file mention. Exact match wins; otherwise the shortest
 * path that ends with the mention (so `@cli.py` finds `src/flask/cli.py` without the
 * user typing the whole path).
 */
export function resolveFileMention(mention: string, knownPaths: string[]): string | undefined {
	const normalised = mention.replace(/\\/g, "/").replace(/^\.\//, "")
	const exact = knownPaths.find((path) => path === normalised)
	if (exact) {
		return exact
	}
	const suffixMatches = knownPaths
		.filter((path) => path.endsWith(`/${normalised}`) || path.endsWith(normalised))
		.sort((a, b) => a.length - b.length)
	return suffixMatches[0]
}

/**
 * Build the ground-truth context block prepended to the user's prompt. Kept separate
 * from the ranking path on purpose: this text is never subject to eviction.
 */
export function formatMentionContext(
	mentions: ParsedMentions,
	resolved: Array<{ kind: "file" | "symbol"; label: string; path: string; startLine: number; endLine: number; text: string }>,
	unresolved: string[],
	usedTokens: number,
	budgetTokens: number,
): string {
	if (resolved.length === 0 && unresolved.length === 0) {
		return ""
	}
	const lines = [
		"## Explicitly mentioned context (ground truth — resolved by the editor, not by retrieval)",
		`mentions: ${[...mentions.files.map((f) => `@${f}`), ...mentions.symbols.map((s) => `@${s}`)].join(", ")}`,
		`budget: ~${usedTokens}/${budgetTokens} tokens`,
	]
	for (const item of resolved) {
		lines.push(`\n### @${item.label} → ${item.path}:${item.startLine}-${item.endLine}\n${item.text}`)
	}
	if (unresolved.length > 0) {
		lines.push(`\nunresolved mentions (nothing in the workspace matched): ${unresolved.map((u) => `@${u}`).join(", ")}`)
	}
	lines.push("\n(End of mentioned context. Use the editor tools for anything else.)")
	return lines.join("\n")
}
