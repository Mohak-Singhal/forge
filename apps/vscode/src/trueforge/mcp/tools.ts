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

import { exec } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import { access, readFile, realpath } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { applyHunks, type EditHunk, sha256 } from "../edits"
import { buildRepoMap, retrieveCode } from "../retrieval"

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

export function stageProposal(ctx: WorkspaceContext, input: { path?: unknown; edits?: unknown; summary?: unknown }): EditProposal {
	const path = typeof input.path === "string" ? input.path.trim() : ""
	if (!path) {
		throw new Error("editor_propose_edit requires a non-empty `path`")
	}
	const abs = resolve(ctx.root, path)
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
		hunks.push({ oldText: candidate.oldText, newText: candidate.newText, intent: typeof candidate.intent === "string" ? candidate.intent : undefined })
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

export async function applyProposal(ctx: WorkspaceContext, id: string): Promise<{ path: string; applied: number; rejected: Array<{ hunk: number; reason: string }> }> {
	const proposal = proposals.get(id)
	if (!proposal) {
		throw new Error(`editor_apply_staged: unknown proposal id ${id}`)
	}
	const abs = resolve(ctx.root, proposal.path)
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
	const abs = resolve(ctx.root, path)
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
	const endLine = typeof args.end_line === "number" ? Math.min(lines.length, args.end_line) : Math.min(lines.length, startLine + 397)
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
	const pattern = typeof input.pattern === "string" && input.pattern.trim() ? input.pattern : typeof input.query === "string" ? input.query : ""
	if (!pattern.trim()) {
		throw new Error("editor_search: `pattern` (or `query`) is required")
	}
	const limit = typeof input.limit === "number" ? Math.min(Math.max(1, input.limit), 200) : 50
	const regex = new RegExp(pattern, "im")
	const files = walkForSearch(ctx.root, 3000)
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
		const rel = relative(ctx.root, file).split("\\").join("/")
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

function walkForSearch(root: string, maxFiles: number): string[] {
	const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs")
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
	return new Promise((resolvePromise) => {
		exec(command, { cwd: ctx.root, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, shell: "/bin/bash" }, (error, stdout, stderr) => {
			const combined = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim()
			const tail = combined.length > MAX_OUTPUT_BYTES ? `…[truncated ${combined.length - MAX_OUTPUT_BYTES} bytes]\n${combined.slice(-MAX_OUTPUT_BYTES)}` : combined
			if (error && !stdout && !stderr) {
				resolvePromise(`command failed to start or timed out: ${error.message}`)
				return
			}
			const exitCode = typeof (error as { code?: number }).code === "number" ? (error as { code?: number }).code : 0
			resolvePromise(`exit code: ${exitCode}\n${tail || "(no output)"}`)
		})
	})
}

export const TOOL_NAMES = [
	"editor_read_file",
	"editor_search",
	"editor_repo_map",
	"editor_retrieve",
	"editor_run_command",
	"editor_propose_edit",
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
			const limit = typeof rawArgs.limit === "number" ? Math.min(Math.max(1, rawArgs.limit), 12) : 6
			const hits = retrieveCode(ctx.root, query, limit)
			return hits.map((hit) => `## ${hit.path}:${hit.startLine}-${hit.endLine} (score ${hit.score.toFixed(2)})\n${hit.text}`).join("\n\n---\n\n") || "no chunks matched"
		}
		case "editor_run_command":
			return runCommand(ctx, rawArgs)
		case "editor_propose_edit": {
			// Called only AFTER TF's approval pause was answered allow — apply immediately.
			const proposal = stageProposal(ctx, rawArgs)
			const before = readFileSyncSafe(resolve(ctx.root, proposal.path))
			const applied = applyHunks(before, proposal.hunks)
			if (!applied.proposed) {
				return JSON.stringify({ status: "rejected", path: proposal.path, applied: applied.applied, rejected: applied.rejected })
			}
			// Snapshot for undo before writing.
			undoSnapshots.set(proposal.id, { path: proposal.path, before, after: applied.proposed })
			const { writeFile } = await import("node:fs/promises")
			await writeFile(resolve(ctx.root, proposal.path), applied.proposed, "utf8")
			return JSON.stringify({ status: "applied", path: proposal.path, proposalId: proposal.id, hunks: applied.applied, bytes: applied.proposed.length })
		}
		case "editor_diagnostics": {
			const path = typeof rawArgs.path === "string" ? rawArgs.path : ""
			if (!path) {
				throw new Error("editor_diagnostics: `path` is required")
			}
			const abs = resolve(ctx.root, path)
			const { execFile } = await import("node:child_process")
			const pyFiles = abs.endsWith(".py") ? [abs] : walkForSearch(ctx.root, 10000).filter(f => f.endsWith(".py")).slice(0, 20)
			const errors: string[] = []
			for (const file of pyFiles) {
				const rel = relative(ctx.root, file).split("\\").join("/")
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
			return errors.length === 0 ? "diagnostics: no Python syntax errors" : `diagnostics: ${errors.length} file(s) with syntax errors:\n${errors.join("\n")}`
		}
		default:
			throw new Error(`unknown tool: ${name}`)
	}
}
