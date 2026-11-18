/**
 * TrueForge-facing retrieval: lightweight BM25 over workspace files.
 * No external deps; designed for ~17k LOC repos (flask) but robust for larger ones.
 * The agent calls this to decide what to read before editing.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { estimateTokens } from "./context-budget"

export interface RetrievedChunk {
	path: string
	startLine: number
	endLine: number
	score: number
	text: string
	reason: string
	/** Query terms this chunk actually contains, strongest first — used to explain the pick. */
	matchedTerms: string[]
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

/**
 * English function words plus the filler that shows up in task descriptions
 * ("add a new ... that prints ... as ..."). Without this filter, BM25 scores "as",
 * "in" and "that" like real signal and a chunk of prose can outrank the module the
 * task is actually about — a CLI question surfacing `testing.py` above `cli.py`.
 */
const STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"been",
	"but",
	"by",
	"can",
	"do",
	"does",
	"for",
	"from",
	"has",
	"have",
	"how",
	"if",
	"in",
	"into",
	"is",
	"it",
	"its",
	"may",
	"must",
	"new",
	"not",
	"of",
	"on",
	"or",
	"our",
	"out",
	"should",
	"so",
	"such",
	"than",
	"that",
	"the",
	"their",
	"them",
	"then",
	"there",
	"these",
	"they",
	"this",
	"to",
	"up",
	"use",
	"using",
	"was",
	"we",
	"were",
	"what",
	"when",
	"where",
	"which",
	"while",
	"who",
	"will",
	"with",
	"would",
	"you",
	"your",
	"add",
	"make",
	"need",
	"please",
	"want",
])

function tokenize(text: string): string[] {
	const out: string[] = []
	const matches = text.toLowerCase().match(/[a-z0-9_]{2,}/g)
	if (matches) {
		out.push(...matches)
	}
	return out
}

/** Query tokens with filler removed. Falls back to the raw tokens if all were filler. */
export function queryTokens(query: string): string[] {
	const raw = tokenize(query).filter((t) => t.length > 1)
	const meaningful = raw.filter((t) => !STOPWORDS.has(t))
	return meaningful.length > 0 ? meaningful : raw
}

interface ScoredChunk {
	path: string
	startLine: number
	endLine: number
	score: number
	text: string
	matchedTerms: Array<{ term: string; hits: number; weight: number }>
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

	const tokensForQuery = queryTokens(query)
	if (tokensForQuery.length === 0) {
		return []
	}
	const querySet = new Set(tokensForQuery)

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
			const matched: Array<{ term: string; hits: number; weight: number }> = []
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
				const scoreTf =
					(occurrenceCount * (k1 + 1)) /
					(occurrenceCount + k1 * (1 - b + (b * lines.length) / Math.max(1, tokens.length)))
				const contribution = scoreTf * idf
				score += contribution
				matched.push({ term: token, hits: occurrenceCount, weight: contribution })
			}
			// Filename boost when query mentions the file stem (common for symbols).
			const stem =
				rel
					.split("/")
					.pop()
					?.replace(/\.[^.]+$/, "")
					.toLowerCase() ?? ""
			if (stem.length >= 3 && [...querySet].some((q) => stem.includes(q) || q.includes(stem))) {
				score *= 1.6
			}
			// Python definition boost for symbol queries.
			if (/^(def |class )/m.test(chunkText)) {
				score *= 1.4
			}
			// Path relevance: a query about CLI commands should favour cli.py over a
			// file that merely mentions the word. Weighted below the filename-stem
			// boost so an exact stem hit still wins.
			const pathLower = rel.toLowerCase()
			const pathHits = [...querySet].filter((q) => q.length >= 3 && pathLower.includes(q)).length
			if (pathHits > 0) {
				score *= 1 + 0.25 * Math.min(pathHits, 3)
			}
			if (score > 0.5) {
				matched.sort((a, b) => b.weight - a.weight)
				chunks.push({
					path: rel,
					startLine: start + 1,
					endLine: end,
					score,
					text: chunkText.slice(0, 4000),
					matchedTerms: matched,
				})
			}
		}
	}

	chunks.sort((a, b) => b.score - a.score)
	const top = chunks.slice(0, Math.max(1, limit))
	return top.map((chunk) => ({
		path: chunk.path,
		startLine: chunk.startLine,
		endLine: chunk.endLine,
		score: chunk.score,
		text: chunk.text,
		matchedTerms: chunk.matchedTerms.map((m) => m.term),
		reason: `BM25 ${chunk.score.toFixed(2)}; terms: ${
			chunk.matchedTerms
				.slice(0, 4)
				.map((m) => m.term)
				.join(", ") || "file-level only"
		}`,
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
 * Compact repository map (like Aider's): files with their top-level definitions,
 * packed into a token budget. The map's job is orientation — enough to know which
 * file owns which symbol without spending context on bodies.
 */
export function buildRepoMap(root: string, maxEntries = 220, budgetTokens = 1500): string {
	const absoluteRoot = resolve(root)
	const files = walk(absoluteRoot, MAX_FILES).sort()
	const perFile: Array<{ rel: string; symbols: string[] }> = []
	for (const file of files.slice(0, maxEntries * 3)) {
		const rel = relative(absoluteRoot, file).split(sep).join("/")
		perFile.push({ rel, symbols: topLevelSymbols(file) })
		if (perFile.length >= maxEntries) {
			break
		}
	}

	// Files with symbols first (they carry more information per line), then the rest.
	const line = (entry: { rel: string; symbols: string[] }): string =>
		entry.symbols.length > 0 ? `${entry.rel}: ${entry.symbols.join(", ")}` : entry.rel

	const out: string[] = []
	let used = 0
	let omitted = 0
	for (const entry of [...perFile].sort((a, b) => b.symbols.length - a.symbols.length)) {
		const text = line(entry)
		const cost = estimateTokens(text) + 1
		if (used + cost > budgetTokens) {
			omitted += 1
			continue
		}
		used += cost
		out.push(text)
	}
	out.sort()
	const header = `repository map: ${out.length} file(s), ~${used}/${budgetTokens} tokens${omitted > 0 ? `, ${omitted} file(s) omitted to fit the budget` : ""}`
	return `${header}\n${out.join("\n")}`
}

/** Top-level `def`/`class` (Python) or `export`ed names, best-effort, no parsing. */
function topLevelSymbols(file: string): string[] {
	const ext = file.slice(file.lastIndexOf(".")).toLowerCase()
	if (![".py", ".js", ".ts", ".tsx", ".jsx", ".rs", ".go"].includes(ext)) {
		return []
	}
	let content = ""
	try {
		content = readFileSync(file, "utf8")
	} catch {
		return []
	}
	const symbols: string[] = []
	for (const raw of content.split("\n")) {
		const py = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(raw)
		if (py) {
			symbols.push(`${raw.startsWith("class") ? "class" : "def"} ${py[1]}`)
			continue
		}
		const js = /^(?:export\s+)?(?:async\s+)?(?:function|class|const|interface|type)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(raw)
		if (js) {
			symbols.push(js[1])
		}
		if (symbols.length >= 12) {
			break
		}
	}
	return symbols
}
