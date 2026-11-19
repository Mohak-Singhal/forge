/**
 * TrueForge editor tools — the MCP handlers for the `vscode-editor-tools` server.
 *
 * These run inside the extension host (not in a sandbox), so they touch the real
 * workspace. The TrueForge agent calls them over the loopback MCP transport.
 * Write tools (editor_propose_edit, editor_run_command) are behind TF's tool
 * approval: the model call pauses until the user approves in the Cline diff UI;
 * the handler only executes after that approval, so nothing touches disk or the
 * shell without explicit user consent.
 */

import { spawn } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import { access, readFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { Logger } from "@shared/services/Logger"
import { estimateTokens, formatPackedContext, packContext } from "../context-budget"
import { applyHunks, type EditHunk, sha256 } from "../edits"
import { isUnreviewedWriteAllowed, proposalKey, takeHunkDecisions } from "../hunk-review"
import { formatMentionContext, parseMentionRange, parseMentions, resolveFileMention } from "../mentions"
import { buildRepoMap, retrieveContext } from "../retrieval"

export interface EditProposal {
	id: string
	path: string
	summary: string
	hunks: EditHunk[]
	baseHash: string
	createdAt: number
}

export interface WorkspaceContext {
	/** Absolute workspace folder (flask checkout). Read-only here. */
	root: string
}

const proposals = new Map<string, EditProposal>()
export const undoSnapshots = new Map<string, { path: string; before: string; after: string }>()

export function stageProposal(
	ctx: WorkspaceContext,
	input: { path?: unknown; edits?: unknown; summary?: unknown },
): EditProposal {
	const path = typeof input.path === "string" ? input.path.trim() : ""
	if (!path) {
		throw new Error("editor_propose_edit requires a non-empty `path`")
	}
	const abs = resolve(realpathSyncSafe(ctx.root), path)
	const rel = relative(realpathSyncSafe(ctx.root), abs)
	if (rel.startsWith("..")) {
		throw new Error(`editor_propose_edit: path escapes workspace: ${path}`)
	}

	const edits = Array.isArray(input.edits) ? input.edits : []
	const hunks: EditHunk[] = []
	for (const [index, edit] of edits.entries()) {
		const candidate = edit as Record<string, unknown>
		if (typeof candidate.oldText !== "string" || typeof candidate.newText !== "string") {
			throw new Error(`editor_propose_edit: edit ${index} needs oldText and newText (strings)`)
		}
		hunks.push({
			oldText: candidate.oldText,
			newText: candidate.newText,
			intent: typeof candidate.intent === "string" ? candidate.intent : undefined,
		})
	}
	if (hunks.length === 0) {
		throw new Error("editor_propose_edit: at least one edit hunk is required")
	}
	const current = readFileSyncSafe(abs)
	const proposal: EditProposal = {
		id: `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		path: rel.split("\\").join("/"),
		summary: typeof input.summary === "string" ? input.summary : "no summary provided",
		hunks,
		baseHash: sha256(current),
		createdAt: Date.now(),
	}
	proposals.set(proposal.id, proposal)
	return proposal
}

export function getProposal(id: string): EditProposal | undefined {
	return proposals.get(id)
}

export async function applyProposal(
	ctx: WorkspaceContext,
	id: string,
): Promise<{ path: string; applied: number; rejected: Array<{ hunk: number; reason: string }> }> {
	const proposal = proposals.get(id)
	if (!proposal) {
		throw new Error(`editor_apply_staged: unknown proposal id ${id}`)
	}
	const abs = resolve(realpathSyncSafe(ctx.root), proposal.path)
	const rel = relative(realpathSyncSafe(ctx.root), abs)
	if (rel.startsWith("..")) {
		throw new Error("editor_apply_staged: path escapes workspace")
	}
	const current = readFileSyncSafe(abs)
	if (sha256(current) !== proposal.baseHash) {
		throw new Error("editor_apply_staged: file changed since proposal was staged (stale base); refusing to apply")
	}
	const result = applyHunks(current, proposal.hunks)
	if (!result.proposed) {
		return { path: proposal.path, applied: result.applied, rejected: result.rejected }
	}
	const { writeFile } = await import("node:fs/promises")
	await writeFile(abs, result.proposed, "utf8")
	return { path: proposal.path, applied: result.applied, rejected: result.rejected }
}

function readFileSyncSafe(abs: string): string {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require("node:fs").readFileSync(abs, "utf8") as string
	} catch (error) {
		throw new Error(`editor_propose_edit: cannot read ${abs}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function realpathSyncSafe(p: string): string {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require("node:fs").realpathSync(p) as string
	} catch {
		return p
	}
}

async function statOrReport(abs: string): Promise<string | undefined> {
	try {
		await access(abs, fsConstants.R_OK)
		return undefined
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
}

async function readToolFile(ctx: WorkspaceContext, args: Record<string, unknown>): Promise<string> {
	const path = typeof args.path === "string" ? args.path : ""
	if (!path.trim()) {
		throw new Error("editor_read_file: `path` is required")
	}
	const abs = resolve(realpathSyncSafe(ctx.root), path)
	const rel = relative(realpathSyncSafe(ctx.root), abs)
	if (rel.startsWith("..")) {
		throw new Error("editor_read_file: path escapes workspace")
	}
	const problem = await statOrReport(abs)
	if (problem) {
		throw new Error(`editor_read_file: cannot read ${path}: ${problem}`)
	}
	const content = await readFile(abs, "utf8")
	const lines = content.split("\n")
	const startLine = typeof args.start_line === "number" ? Math.max(1, args.start_line) : 1
	const endLine =
		typeof args.end_line === "number" ? Math.min(lines.length, args.end_line) : Math.min(lines.length, startLine + 397)
	const slice = lines.slice(startLine - 1, endLine)
	return `# ${path} (lines ${startLine}-${endLine} of ${lines.length})\n${slice.map((line, i) => `${startLine + i}\t${line}`).join("\n")}`
}

interface SearchArgs {
	query?: unknown
	pattern?: unknown
	path?: unknown
	glob?: unknown
	limit?: unknown
}

async function searchText(ctx: WorkspaceContext, args: Record<string, unknown>): Promise<string> {
	const input = args as SearchArgs
	const pattern =
		typeof input.pattern === "string" && input.pattern.trim()
			? input.pattern
			: typeof input.query === "string"
				? input.query
				: ""
	if (!pattern.trim()) {
		throw new Error("editor_search: `pattern` (or `query`) is required")
	}
	const limit = typeof input.limit === "number" ? Math.min(Math.max(1, input.limit), 200) : 50
	const regex = new RegExp(pattern, "im")
	const files = walkForSearch(ctx.root)
	const results: string[] = []
	for (const file of files) {
		if (results.length >= limit) {
			break
		}
		let content = ""
		try {
			content = await readFile(file, "utf8")
		} catch {
			continue
		}
		const lines = content.split("\n")
		const rel = relative(realpathSyncSafe(ctx.root), file).split("\\").join("/")
		const scope = typeof input.path === "string" ? input.path.trim() : ""
		if (scope && !rel.startsWith(scope.replace(/^\.\//, ""))) {
			continue
		}
		for (const [index, line] of lines.entries()) {
			if (results.length >= limit) {
				break
			}
			if (regex.test(line)) {
				results.push(`${rel}:${index + 1}: ${line.trim()}`)
			}
		}
	}
	return results.length === 0 ? `no matches for /${pattern}/` : results.join("\n")
}

function walkForSearch(root: string, maxFiles = 5000): string[] {
	const { readdirSync } = require("node:fs") as typeof import("node:fs")
	const { join: joinPath } = require("node:path") as typeof import("node:path")
	const stack = [root]
	const files: string[] = []
	const skipDirs = new Set(["node_modules", ".git", ".venv", "venv", "dist", "out", "build", "coverage", "__pycache__"])
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
			if (entry.isDirectory()) {
				if (!skipDirs.has(entry.name)) {
					stack.push(joinPath(dir, entry.name))
				}
				continue
			}
			if (entry.isFile()) {
				files.push(joinPath(dir, entry.name))
			}
		}
	}
	return files
}

const COMMAND_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 8 * 1024

async function undoLastEdit(ctx: WorkspaceContext, args: Record<string, unknown>): Promise<string> {
	const proposalId = typeof args.proposalId === "string" ? args.proposalId : undefined
	let id = proposalId
	if (!id) {
		id = [...undoSnapshots.keys()].at(-1)
	}
	if (!id) {
		return JSON.stringify({ status: "error", message: "no applied edits to undo in this session" })
	}
	const snap = undoSnapshots.get(id)
	if (!snap) {
		return JSON.stringify({ status: "error", message: `unknown proposalId ${id} (or it was already undone)` })
	}
	const root = realpathSyncSafe(ctx.root)
	const abs = resolve(root, snap.path)
	if (!abs.startsWith(root)) {
		return JSON.stringify({ status: "error", message: `proposal path escapes workspace: ${snap.path}` })
	}
	// Refuse to clobber a file that changed after our write: undo means "put my edit
	// back", not "discard everything written since". The caller can force it only by
	// re-proposing; nothing here silently overwrites a newer user edit.
	const current = readFileSyncSafe(abs)
	if (sha256(current) !== sha256(snap.after)) {
		return JSON.stringify({
			status: "stale",
			path: snap.path,
			proposalId: id,
			message: "the file changed after this edit was applied; refusing to overwrite the newer content",
		})
	}
	const { writeFile } = await import("node:fs/promises")
	await writeFile(abs, snap.before, "utf8")
	// The undo itself is undoable only by re-proposing; drop the snapshot so it cannot
	// be applied twice over unrelated later edits.
	undoSnapshots.delete(id)
	return JSON.stringify({ status: "undone", path: snap.path, proposalId: id, bytes: snap.before.length })
}

function runCommand(ctx: WorkspaceContext, args: Record<string, unknown>): Promise<string> {
	const command = typeof args.command === "string" ? args.command.trim() : ""
	if (!command) {
		throw new Error("editor_run_command: `command` is required")
	}
	const lowered = command.toLowerCase()
	const forbidden = ["rm -rf", "git push", "git commit", "sudo ", "curl ", "wget "]
	for (const banned of forbidden) {
		if (lowered.includes(banned)) {
			throw new Error(`editor_run_command: refused to run potentially destructive/network command: ${banned.trim()}`)
		}
	}
	Logger.log(`[Forge] editor_run_command start: ${command}`)
	const root = ctx.root.replace(/"/g, '\\"')
	const wrapped = `cd "${root}" && ${command}`
	// Use spawn with manual collection (same libuv path diagnostics uses) and a
	// watchdog, instead of execFile's callback wrapper.
	return new Promise((resolvePromise) => {
		const child = spawn("/bin/bash", ["-c", wrapped], { stdio: ["ignore", "pipe", "pipe"] })
		let stdout = ""
		let stderr = ""
		const timer = setTimeout(() => {
			child.kill("SIGKILL")
		}, COMMAND_TIMEOUT_MS)
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < 8 * 1024 * 1024) stdout += chunk.toString()
		})
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 8 * 1024 * 1024) stderr += chunk.toString()
		})
		child.on("error", (spawnError) => {
			clearTimeout(timer)
			Logger.log(`[Forge] editor_run_command spawn error: ${spawnError.message}`)
			resolvePromise(`command failed to start: ${spawnError.message}`)
		})
		child.on("close", (code, signal) => {
			clearTimeout(timer)
			const combined = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim()
			const tail =
				combined.length > MAX_OUTPUT_BYTES
					? `…[truncated ${combined.length - MAX_OUTPUT_BYTES} bytes]\n${combined.slice(-MAX_OUTPUT_BYTES)}`
					: combined
			Logger.log(`[Forge] editor_run_command done: code=${code} signal=${signal} bytes=${combined.length}`)
			resolvePromise(`exit code: ${code ?? 0}\n${tail || "(no output)"}`)
		})
	})
}

/**
 * Resolve `@file` / `@symbol` mentions against the workspace and render them as a
 * ground-truth block. Explicit mentions are never ranked and never evicted: a user
 * naming a file outranks any retrieval score, so this block goes ahead of the prompt
 * instead of competing with retrieved chunks for the budget.
 */
export function resolveMentionContext(
	ctx: WorkspaceContext,
	prompt: string,
	budgetTokens = 6000,
): { contextText: string; promptText: string; files: string[]; symbols: string[] } {
	const mentions = parseMentions(prompt)
	if (mentions.files.length === 0 && mentions.symbols.length === 0) {
		return { contextText: "", promptText: prompt, files: [], symbols: [] }
	}

	const root = realpathSyncSafe(ctx.root)
	const knownPaths = walkForSearch(root)
		.map((file) => relative(root, file).split("\\").join("/"))
		.filter((path) => !path.startsWith(".."))

	const resolved: Array<{
		kind: "file" | "symbol"
		label: string
		path: string
		startLine: number
		endLine: number
		text: string
	}> = []
	const unresolved: string[] = []
	let remaining = budgetTokens

	for (const raw of mentions.files) {
		const { path: mentionPath, startLine, endLine } = parseMentionRange(raw)
		const match = resolveFileMention(mentionPath, knownPaths)
		if (!match) {
			unresolved.push(raw)
			continue
		}
		const abs = resolve(root, match)
		let content = ""
		try {
			content = readFileSyncSafe(abs)
		} catch {
			unresolved.push(raw)
			continue
		}
		const lines = content.split("\n")
		const from = startLine ?? 1
		const to = endLine ?? Math.min(lines.length, from + 399)
		const body = lines
			.slice(from - 1, to)
			.map((line, index) => `${from + index}\t${line}`)
			.join("\n")
		const cost = estimateTokens(body)
		if (cost > remaining) {
			unresolved.push(`${raw} (does not fit the remaining mention budget)`)
			continue
		}
		remaining -= cost
		resolved.push({ kind: "file", label: raw, path: match, startLine: from, endLine: to, text: body })
	}

	// Symbols: find the definition line, then include that definition's body.
	for (const symbol of mentions.symbols) {
		const definition = findSymbolDefinition(root, knownPaths, symbol)
		if (!definition) {
			unresolved.push(symbol)
			continue
		}
		const cost = estimateTokens(definition.text)
		if (cost > remaining) {
			unresolved.push(`${symbol} (does not fit the remaining mention budget)`)
			continue
		}
		remaining -= cost
		resolved.push({ kind: "symbol", label: symbol, ...definition })
	}

	const usedTokens = budgetTokens - remaining
	return {
		contextText: formatMentionContext(mentions, resolved, unresolved, usedTokens, budgetTokens),
		promptText: mentions.text || prompt,
		files: mentions.files,
		symbols: mentions.symbols,
	}
}

/** Locate `def name` / `class name` / `function name` and take a bounded body. */
function findSymbolDefinition(
	root: string,
	knownPaths: string[],
	symbol: string,
	maxLines = 120,
): { path: string; startLine: number; endLine: number; text: string } | undefined {
	const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const pattern = new RegExp(
		`^\\s*(?:export\\s+)?(?:async\\s+)?(?:def|class|function|interface|type|const|let|var)\\s+${escaped}\\b`,
	)
	for (const path of knownPaths) {
		if (!/\.(py|ts|tsx|js|jsx|rs|go)$/.test(path)) {
			continue
		}
		let content = ""
		try {
			content = readFileSyncSafe(resolve(root, path))
		} catch {
			continue
		}
		const lines = content.split("\n")
		for (const [index, line] of lines.entries()) {
			if (!pattern.test(line)) {
				continue
			}
			const startLine = index + 1
			// Take the definition plus its indented body, stopping at the next
			// same-or-higher-indent definition or after maxLines.
			const baseIndent = line.length - line.trimStart().length
			let endLine = Math.min(lines.length, startLine + maxLines - 1)
			for (let probe = index + 1; probe < lines.length && probe < index + maxLines; probe++) {
				const candidate = lines[probe]
				if (!candidate.trim()) {
					continue
				}
				const indent = candidate.length - candidate.trimStart().length
				if (indent <= baseIndent && /^\s*(?:export\s+)?(?:async\s+)?(?:def|class|function)/.test(candidate)) {
					endLine = probe
					break
				}
			}
			const body = lines
				.slice(startLine - 1, endLine)
				.map((text, offset) => `${startLine + offset}\t${text}`)
				.join("\n")
			return { path, startLine, endLine, text: body }
		}
	}
	return undefined
}

/** Apply every hunk that still matches cleanly; skip the ones that drifted. */
function applyApplicableHunks(original: string, hunks: EditHunk[]): string {
	let current = original
	for (const hunk of hunks) {
		if (!hunk || hunk.oldText.length === 0) {
			current += hunk?.newText ?? ""
			continue
		}
		const first = current.indexOf(hunk.oldText)
		if (first === -1) {
			continue
		}
		if (current.indexOf(hunk.oldText, first + 1) !== -1) {
			continue
		}
		current = current.slice(0, first) + hunk.newText + current.slice(first + hunk.oldText.length)
	}
	return current
}

export const TOOL_NAMES = [
	"editor_read_file",
	"editor_search",
	"editor_repo_map",
	"editor_retrieve",
	"editor_run_command",
	"editor_propose_edit",
	"editor_undo_last_edit",
	"editor_diagnostics",
] as const

export type EditorToolName = (typeof TOOL_NAMES)[number]

export async function callEditorTool(name: string, rawArgs: Record<string, unknown>, ctx: WorkspaceContext): Promise<string> {
	switch (name) {
		case "editor_read_file":
			return readToolFile(ctx, rawArgs)
		case "editor_search":
			return searchText(ctx, rawArgs)
		case "editor_repo_map":
			return buildRepoMap(ctx.root)
		case "editor_retrieve": {
			const query = typeof rawArgs.query === "string" ? rawArgs.query : ""
			const limit = typeof rawArgs.limit === "number" ? Math.min(Math.max(1, rawArgs.limit), 12) : 8
			const budgetTokens =
				typeof rawArgs.budget_tokens === "number" ? Math.min(Math.max(256, rawArgs.budget_tokens), 16000) : undefined
			// Rank, add symbol-linked test/doc candidates, then pack into the fixed budget.
			// The plan returns more candidates than the budget can hold, so eviction
			// decisions stay visible in the report the agent reads.
			const plan = retrieveContext(ctx.root, query, { maxChunks: limit })
			const intent = [plan.intent.tests ? "tests" : "", plan.intent.docs ? "docs" : ""].filter(Boolean).join("+")
			const packed = packContext(
				plan.chunks.map((hit) => ({
					path: hit.path,
					startLine: hit.startLine,
					endLine: hit.endLine,
					score: hit.score,
					text: hit.text,
					matchedTerms: hit.matchedTerms,
					why: hit.why,
				})),
				{
					budgetTokens,
					maxChunks: limit,
					header: `query: "${query.length > 200 ? `${query.slice(0, 200).trimEnd()}…` : query}"${
						intent ? ` · intent: ${intent}` : ""
					}`,
					selectedFrom: plan.considered,
				},
			)
			return formatPackedContext(packed)
		}
		case "editor_run_command":
			return runCommand(ctx, rawArgs)
		case "editor_undo_last_edit":
			return undoLastEdit(ctx, rawArgs)
		case "editor_propose_edit": {
			// Called only AFTER TF's approval pause was answered allow — apply immediately.
			const proposal = stageProposal(ctx, rawArgs)
			const before = readFileSyncSafe(resolve(realpathSyncSafe(ctx.root), proposal.path))
			// Per-hunk decisions recorded by the review UI. When the user reviewed the
			// diff and rejected some hunks, only the accepted ones are applied.
			//
			// Fail closed: approval in the chat means "the agent may apply", not "apply
			// everything". If no review was recorded, the diff the user was shown never
			// produced a decision, so writing would be a silent write. Refuse instead and
			// tell the agent to re-propose. The only exception is the explicit headless
			// seam used by automated tests, which the extension never enables.
			const decision = takeHunkDecisions(proposalKey(proposal.path, proposal.hunks), proposal.hunks.length)
			let accepted: boolean[]
			if (decision.kind === "reviewed") {
				accepted = decision.accepted
			} else if (isUnreviewedWriteAllowed()) {
				accepted = proposal.hunks.map(() => true)
			} else {
				Logger.warn(`[Forge] refusing unreviewed edit to ${proposal.path}: ${decision.reason}`)
				return JSON.stringify({
					status: "unreviewed",
					path: proposal.path,
					applied: 0,
					rejected: [],
					message: `No hunk review was recorded for this proposal (${decision.reason}). Nothing was written. Re-propose the edit so the user can review the diff.`,
				})
			}
			const hunksToApply = proposal.hunks.filter((_, index) => accepted[index])
			const declinedHunks = accepted.filter((wasAccepted) => !wasAccepted).length
			if (hunksToApply.length === 0) {
				return JSON.stringify({
					status: "rejected",
					path: proposal.path,
					applied: 0,
					rejected: proposal.hunks.map((_, index) => ({ hunk: index, reason: "rejected by the user in review" })),
				})
			}
			const applied = applyHunks(before, hunksToApply)
			// A single stale hunk must not discard the hunks the user approved: apply
			// every accepted hunk that still matches and report the ones that did not.
			const proposed = applied.proposed ?? applyApplicableHunks(before, hunksToApply)
			if (applied.applied === 0 || proposed === before) {
				return JSON.stringify({
					status: "rejected",
					path: proposal.path,
					applied: 0,
					rejected: applied.rejected,
				})
			}
			// Snapshot for undo before writing.
			undoSnapshots.set(proposal.id, { path: proposal.path, before, after: proposed })
			const { writeFile } = await import("node:fs/promises")
			await writeFile(resolve(realpathSyncSafe(ctx.root), proposal.path), proposed, "utf8")
			return JSON.stringify({
				status: "applied",
				path: proposal.path,
				proposalId: proposal.id,
				hunks: applied.applied,
				declinedHunks,
				rejected: applied.rejected,
				bytes: proposed.length,
			})
		}
		case "editor_diagnostics": {
			const path = typeof rawArgs.path === "string" ? rawArgs.path : ""
			if (!path) {
				throw new Error("editor_diagnostics: `path` is required")
			}
			const abs = resolve(realpathSyncSafe(ctx.root), path)
			const { execFile } = await import("node:child_process")
			const pyFiles = abs.endsWith(".py")
				? [abs]
				: walkForSearch(ctx.root)
						.filter((f) => f.endsWith(".py"))
						.slice(0, 20)
			const errors: string[] = []
			for (const file of pyFiles) {
				const rel = relative(realpathSyncSafe(ctx.root), file).split("\\").join("/")
				const err = await new Promise<string>((resolveP) => {
					execFile("python3", ["-m", "py_compile", file], (e) => {
						if (!e) return resolveP("")
						resolveP("syntax error")
					})
				})
				if (err) {
					errors.push(`${rel}: ${err}`)
				}
			}
			return errors.length === 0
				? "diagnostics: no Python syntax errors"
				: `diagnostics: ${errors.length} file(s) with syntax errors:\n${errors.join("\n")}`
		}
		default:
			throw new Error(`unknown tool: ${name}`)
	}
}
