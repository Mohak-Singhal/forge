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
	/** Set when the chunk was added because it references a symbol from a stronger chunk. */
	why?: string
	/** Symbols that linked this chunk to the implementation (selection uses the count). */
	linkedSymbols?: string[]
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

/** A retrieval plan: the ranked chunk list plus why it was shaped this way. */
export interface RetrievalPlan {
	query: string
	chunks: RetrievedChunk[]
	/** Whether the task asked for tests / documentation, which drives the coverage quota. */
	intent: { tests: boolean; docs: boolean }
	/** Files added by symbol-reference linking (not by BM25 alone). */
	linkedFiles: string[]
	/** Candidate chunks ranked before selection. */
	considered: number
}

export interface RetrievalPlanOptions {
	/** Slots to fill (default 8). */
	maxChunks?: number
	/** Candidate pool handed to the selector (default 40). */
	maxCandidates?: number
}

const TEST_INTENT = /\b(test|tests|tested|testing|pytest|unittest|coverage)\b/i
const DOC_INTENT = /\b(doc|docs|document\w*|readme|help|usage|guide)\b/i
const LINKED_LIMIT = 24
const MAX_CHUNKS_PER_FILE = 2
/** The best-ranked file may contribute one extra chunk: that is the file being edited. */
const MAX_CHUNKS_TOP_FILE = 3
/** A symbol must not appear in more files than this or it links half the repository. */
const MAX_SYMBOL_FILES = 10

export function isTestPath(path: string): boolean {
	return /(^|\/)(tests?|__tests__)\//.test(path) || /(^|\/)test_[^/]+$/.test(path) || /_test\.(py|ts|js|tsx|jsx)$/.test(path)
}

export function isDocPath(path: string): boolean {
	return /\.(rst|md|mdx|txt)$/.test(path) || /(^|\/)docs?\//.test(path)
}

/** `def`/`class` names (Python) or exported names (JS/TS), best-effort. */
function definedSymbols(text: string): string[] {
	const out = new Set<string>()
	for (const line of text.split("\n")) {
		const py = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line)
		if (py) {
			out.add(py[1])
		}
		const js = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|const|interface|type)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(
			line,
		)
		if (js) {
			out.add(js[1])
		}
		if (out.size >= 40) {
			break
		}
	}
	return [...out]
}

/** The window that contains the most distinct link symbols (ties: more references). */
function bestSymbolWindow(
	content: string,
	symbols: string[],
): { startLine: number; endLine: number; text: string; distinct: number } {
	const lines = content.split("\n")
	let best = { start: 0, distinct: 0, refs: 0 }
	for (let start = 0; start < lines.length; start += CHUNK_LINES) {
		const end = Math.min(start + CHUNK_LINES, lines.length)
		const slice = lines.slice(start, end).join("\n")
		let distinct = 0
		let refs = 0
		for (const symbol of symbols) {
			const hits = slice.split(symbol).length - 1
			if (hits > 0) {
				distinct += 1
				refs += hits
			}
		}
		if (distinct > best.distinct || (distinct === best.distinct && refs > best.refs)) {
			best = { start, distinct, refs }
		}
	}
	const end = Math.min(best.start + CHUNK_LINES, lines.length)
	return {
		startLine: best.start + 1,
		endLine: end,
		text: lines.slice(best.start, end).join("\n"),
		distinct: best.distinct,
	}
}

/**
 * Rank the workspace for a task, then improve the ranking with static links:
 *
 * 1. BM25 ranks chunks (the existing retriever).
 * 2. The strongest implementation chunks define symbols. A file that references two or
 *    more of those symbols (an import, a call, an `autoclass::`, a doc cross-reference)
 *    is a likely test or doc for that code, even when its prose scores poorly.
 * 3. Selection keeps the strongest chunks, guarantees one test and one doc chunk when
 *    the task asks for them, and never takes more than two chunks from one file.
 *
 * Nothing here knows repository names or file names; the links come from the code.
 */
export function retrieveContext(root: string, query: string, options: RetrievalPlanOptions = {}): RetrievalPlan {
	const maxChunks = Math.max(1, Math.min(options.maxChunks ?? 8, 12))
	const maxCandidates = Math.max(maxChunks, options.maxCandidates ?? 40)
	const intent = { tests: TEST_INTENT.test(query), docs: DOC_INTENT.test(query) }
	const base = retrieveCode(root, query, maxCandidates)
	if (base.length === 0) {
		return { query, chunks: [], intent, linkedFiles: [], considered: 0 }
	}

	const absoluteRoot = resolve(root)
	const files = walk(absoluteRoot, MAX_FILES)
	const relOf = (file: string) => relative(absoluteRoot, file).split(sep).join("/")
	const contents = new Map<string, string>()
	const readFile = (file: string): string => {
		if (!contents.has(file)) {
			try {
				contents.set(file, readFileSync(file, "utf8"))
			} catch {
				contents.set(file, "")
			}
		}
		return contents.get(file) ?? ""
	}

	const seeds = base.filter((chunk) => !isTestPath(chunk.path) && !isDocPath(chunk.path)).slice(0, 6)
	const names = new Set<string>()
	for (const seed of seeds) {
		for (const symbol of definedSymbols(seed.text)) {
			if (symbol.length >= 5 && !symbol.startsWith("__") && !symbol.endsWith("__")) {
				names.add(symbol)
			}
		}
	}
	const symbolFiles = new Map<string, number>()
	for (const symbol of names) {
		let count = 0
		for (const file of files) {
			if (readFile(file).includes(symbol)) {
				count += 1
			}
		}
		symbolFiles.set(symbol, count)
	}
	const linkSymbols = [...names].filter((symbol) => (symbolFiles.get(symbol) ?? 0) <= MAX_SYMBOL_FILES).slice(0, 14)
	const bestBase = base[0]?.score ?? 1

	const linkedCandidates: RetrievedChunk[] = []
	if (linkSymbols.length >= 2) {
		for (const file of files) {
			const content = readFile(file)
			if (!content) {
				continue
			}
			const present = linkSymbols.filter((symbol) => content.includes(symbol))
			if (present.length < 2) {
				continue
			}
			const window = bestSymbolWindow(content, present)
			if (window.distinct < 2) {
				continue
			}
			const sourceScore = Math.max(
				0,
				...seeds.filter((seed) => present.some((symbol) => seed.text.includes(symbol))).map((seed) => seed.score),
			)
			const anchor = sourceScore > 0 ? sourceScore : bestBase * 0.4
			const score = Math.min(anchor * 0.95, anchor * (0.55 + 0.08 * Math.min(window.distinct, 4)))
			const rel = relOf(file)
			linkedCandidates.push({
				path: rel,
				startLine: window.startLine,
				endLine: window.endLine,
				score,
				text: window.text,
				matchedTerms: [],
				reason: "",
				why: `links to ${present.slice(0, 3).join(", ")}`,
				linkedSymbols: present,
			})
		}
	}
	// Directory walk order is arbitrary; keep the strongest links, not the first ones.
	linkedCandidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine)
	const linked = linkedCandidates.slice(0, LINKED_LIMIT)
	const linkedFiles = linked.map((chunk) => chunk.path)

	const terms = [...new Set(queryTokens(query))]
	const byKey = new Map<string, number>()
	const rescored: RetrievedChunk[] = []
	for (const chunk of [...base, ...linked]) {
		const key = `${chunk.path}:${chunk.startLine}`
		const existing = byKey.get(key)
		if (existing !== undefined) {
			// The same window can be found by BM25 and by symbol linking; keep the
			// stronger score but keep the link note so the reason line explains it.
			const current = rescored[existing]
			if (!current.why && chunk.why) {
				rescored[existing] = { ...current, why: chunk.why }
			}
			continue
		}
		byKey.set(key, rescored.length)
		let score = chunk.score
		const chunkSymbols = definedSymbols(chunk.text)
		const symbolHits = terms.filter((token) =>
			chunkSymbols.some((symbol) => symbol.toLowerCase().startsWith(token) || token.startsWith(symbol.toLowerCase())),
		).length
		if (symbolHits > 0) {
			score *= 1 + Math.min(0.08 * symbolHits, 0.16)
		}
		if (intent.tests && isTestPath(chunk.path)) {
			score *= 1.06
		}
		if (intent.docs && isDocPath(chunk.path)) {
			score *= 1.06
		}
		rescored.push({ ...chunk, score })
	}
	rescored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine)

	const picked: RetrievedChunk[] = []
	const perFile = new Map<string, number>()
	const topFile = rescored[0]?.path
	const add = (chunk: RetrievedChunk): boolean => {
		if (picked.length >= maxChunks) {
			return false
		}
		if (picked.some((item) => item.path === chunk.path && item.startLine === chunk.startLine)) {
			return false
		}
		const count = perFile.get(chunk.path) ?? 0
		const cap = chunk.path === topFile ? MAX_CHUNKS_TOP_FILE : MAX_CHUNKS_PER_FILE
		if (count >= cap) {
			return false
		}
		picked.push(chunk)
		perFile.set(chunk.path, count + 1)
		return true
	}
	// Keep the strongest chunks first: the implementation is what the agent has to edit.
	for (const chunk of rescored) {
		if (picked.length >= 3) {
			break
		}
		add(chunk)
	}
	// Then guarantee coverage for explicit test/documentation asks, without spending
	// more than one slot each (a second doc/test is only added by the fill below).
	// Prefer a test/doc that actually links to the implementation's symbols over one
	// that merely shares words with the query.
	const byLinkStrength = (a: RetrievedChunk, b: RetrievedChunk) =>
		(b.linkedSymbols?.length ?? 0) - (a.linkedSymbols?.length ?? 0) || b.score - a.score
	if (intent.tests && !picked.some((chunk) => isTestPath(chunk.path))) {
		const test = [...rescored.filter((chunk) => isTestPath(chunk.path))].sort(byLinkStrength)[0]
		if (test) {
			add(test)
		}
	}
	if (intent.docs) {
		const docsPicked = new Set(
			picked.filter((chunk) => isDocPath(chunk.path) && !isTestPath(chunk.path)).map((chunk) => chunk.path),
		)
		if (docsPicked.size === 0) {
			const doc = [...rescored.filter((chunk) => isDocPath(chunk.path) && !isTestPath(chunk.path))].sort(byLinkStrength)[0]
			if (doc) {
				add(doc)
				docsPicked.add(doc.path)
			}
		}
		// "Documented alongside the other commands" usually spans a guide page and an
		// API page; take one more distinct doc file when the task asked for docs.
		if (docsPicked.size === 1) {
			const second = [...rescored]
				.filter((chunk) => isDocPath(chunk.path) && !isTestPath(chunk.path) && !docsPicked.has(chunk.path))
				.sort(byLinkStrength)[0]
			if (second) {
				add(second)
			}
		}
	}
	for (const chunk of rescored) {
		if (picked.length >= maxChunks) {
			break
		}
		add(chunk)
	}

	return {
		query,
		chunks: picked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine),
		intent,
		linkedFiles,
		considered: rescored.length,
	}
}
