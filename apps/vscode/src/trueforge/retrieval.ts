/**
 * TrueForge-facing retrieval: lightweight BM25 over workspace files.
 * No external deps; designed for ~17k LOC repos (flask) but robust for larger ones.
 * The agent calls this to decide what to read before editing.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"

export interface RetrievedChunk {
	path: string
	startLine: number
	endLine: number
	score: number
	text: string
	reason: string
}

const TEXT_EXTENSIONS = new Set([
	".py",
	".js",
	".ts",
	".tsx",
	".jsx",
	".json",
	".md",
	".txt",
	".rst",
	".yaml",
	".yml",
	".toml",
	".ini",
	".cfg",
	".css",
	".html",
	".sh",
	".rs",
	".go",
	".java",
	".c",
	".cc",
	".cpp",
	".h",
])

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".hg",
	".svn",
	"dist",
	"out",
	"build",
	"coverage",
	"__pycache__",
	".venv",
	"venv",
	".tox",
	".mypy_cache",
	".pytest_cache",
	".idea",
	".vscode-test",
])

const MAX_FILE_BYTES = 512 * 1024
const MAX_FILES = 4000
const CHUNK_LINES = 40

function tokenize(text: string): string[] {
	const out: string[] = []
	const matches = text.toLowerCase().match(/[a-z0-9_]{2,}/g)
	if (matches) {
		out.push(...matches)
	}
	return out
}

interface ScoredChunk {
	path: string
	startLine: number
	endLine: number
	score: number
	text: string
}

function walk(root: string, maxFiles: number): string[] {
	const stack = [root]
	const files: string[] = []
	while (stack.length > 0) {
		const dir = stack.pop() as string
		let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = []
		try {
			entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{
				name: string
				isDirectory: () => boolean
				isFile: () => boolean
			}>
		} catch {
			continue
		}
		for (const entry of entries) {
			if (files.length >= maxFiles) {
				return files
			}
			if (entry.name.startsWith(".") && entry.name !== ".trueforge") {
				if (entry.isDirectory()) {
					continue
				}
			}
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) {
					stack.push(join(dir, entry.name))
				}
				continue
			}
			if (!entry.isFile()) {
				continue
			}
			const dot = entry.name.lastIndexOf(".")
			const ext = dot >= 0 ? entry.name.slice(dot).toLowerCase() : ""
			if (!TEXT_EXTENSIONS.has(ext)) {
				continue
			}
			files.push(join(dir, entry.name))
		}
	}
	return files
}

/**
 * Rank workspace files against a natural-language query.
 * Returns up to `limit` chunks with scores and reasons.
 */
export function retrieveCode(root: string, query: string, limit = 8): RetrievedChunk[] {
	const absoluteRoot = resolve(root)
	const files = walk(absoluteRoot, MAX_FILES)
	if (files.length === 0) {
		return []
	}

	const queryTokens = tokenize(query).filter((t) => t.length > 1)
	if (queryTokens.length === 0) {
		return []
	}
	const querySet = new Set(queryTokens)

	// Document frequency per token.
	const df = new Map<string, number>()
	const docTokens: Array<{ file: string; tokens: string[] }> = []

	for (const file of files) {
		let content = ""
		try {
			const stat = statSync(file)
			if (stat.size > MAX_FILE_BYTES) {
				continue
			}
			content = readFileSync(file, "utf8")
		} catch {
			continue
		}
		const tokens = tokenize(content)
		const unique = new Set(tokens)
		for (const t of unique) {
			if (querySet.has(t)) {
				df.set(t, (df.get(t) ?? 0) + 1)
			}
		}
		docTokens.push({ file, tokens })
	}

	const N = docTokens.length
	const chunks: ScoredChunk[] = []

	for (const { file, tokens } of docTokens) {
		const tf = new Map<string, number>()
		for (const t of tokens) {
			if (querySet.has(t)) {
				tf.set(t, (tf.get(t) ?? 0) + 1)
			}
		}
		if (tf.size === 0) {
			continue
		}
		const rel = relative(absoluteRoot, file).split(sep).join("/")

		// Split into chunks.
		let content = ""
		try {
			content = readFileSync(file, "utf8")
		} catch {
			continue
		}
		const lines = content.split("\n")
		for (let start = 0; start < lines.length; start += CHUNK_LINES) {
			const end = Math.min(start + CHUNK_LINES, lines.length)
			const chunkText = lines.slice(start, end).join("\n")
			const chunkLower = chunkText.toLowerCase()
			let score = 0
			for (const [token, freq] of tf) {
				const idf = Math.log((N + 1) / ((df.get(token) ?? 0) + 1)) + 1
				const k1 = 1.2
				const b = 0.75
				// Recompute per-chunk frequency for finer signal.
				const occurrenceCount = countOccurrences(chunkLower, token)
				if (occurrenceCount === 0) {
					// Partial credit from file-level frequency so symbol-only mentions still surface.
					score += 0.2 * Math.log(1 + freq) * idf
					continue
				}
				const scoreTf = (occurrenceCount * (k1 + 1)) / (occurrenceCount + k1 * (1 - b + (b * lines.length) / Math.max(1, tokens.length)))
				score += scoreTf * idf
			}
			// Filename boost when query mentions the file stem (common for symbols).
			const stem = rel.split("/").pop()?.replace(/\.[^.]+$/, "").toLowerCase() ?? ""
			if (stem.length >= 3 && [...querySet].some((q) => stem.includes(q) || q.includes(stem))) {
				score *= 1.6
			}
			// Python definition boost for symbol queries.
			if (/^(def |class )/m.test(chunkText)) {
				score *= 1.4
			}
			if (score > 0.5) {
				chunks.push({ path: rel, startLine: start + 1, endLine: end, score, text: chunkText.slice(0, 4000) })
			}
		}
	}

	chunks.sort((a, b) => b.score - a.score)
	const top = chunks.slice(0, Math.max(1, limit))
	return top.map((chunk) => ({
		...chunk,
		reason: `BM25 score ${chunk.score.toFixed(2)} for query terms`,
	}))
}

function countOccurrences(text: string, token: string): number {
	if (!token) {
		return 0
	}
	let count = 0
	let idx = text.indexOf(token)
	while (idx !== -1) {
		count++
		idx = text.indexOf(token, idx + token.length)
	}
	return count
}

/**
 * Compact repository map (like Aider's): directories + file stems + def/class lines,
 * capped to a token budget by callers.
 */
export function buildRepoMap(root: string, maxEntries = 220): string {
	const absoluteRoot = resolve(root)
	const files = walk(absoluteRoot, MAX_FILES)
	const lines: string[] = []
	for (const file of files.slice(0, maxEntries * 3)) {
		const rel = relative(absoluteRoot, file).split(sep).join("/")
		lines.push(rel)
		if (lines.length >= maxEntries) {
			break
		}
	}
	return lines.sort().join("\n")
}
