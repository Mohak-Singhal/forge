import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { describe, expect, it } from "vitest"
import { isForgeWriteTool, isToolAutoApproved } from "./sdk-tool-policies"

describe("isToolAutoApproved", () => {
	it("does not auto-approve command tools by default", () => {
		expect(isToolAutoApproved("run_commands", DEFAULT_AUTO_APPROVAL_SETTINGS)).toBe(false)
	})

	it("uses executeSafeCommands as the single command approval flag", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: {
				...DEFAULT_AUTO_APPROVAL_SETTINGS.actions,
				executeSafeCommands: false,
				executeAllCommands: true,
			},
		}

		expect(isToolAutoApproved("run_commands", settings)).toBe(false)
	})

	it("auto-approves all MCP tools when the Use MCP servers toggle is on", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useMcp: true },
		}

		expect(isToolAutoApproved("firecrawl__scrape", settings)).toBe(true)
	})

	it("prompts for MCP tools when the Use MCP servers toggle is off", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useMcp: false },
		}

		expect(isToolAutoApproved("firecrawl__scrape", settings)).toBe(false)
	})

	// The diff-review bypass: with Use MCP servers on, every MCP tool was auto-approved,
	// including the Forge edit tool. The write then ran without the diff review ever
	// being shown. Write tools must never be auto-approved by the MCP toggle.
	it("never auto-approves Forge write tools even with Use MCP servers on", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useMcp: true },
		}

		expect(isToolAutoApproved("vscode-editor-tools__editor_propose_edit", settings)).toBe(false)
		expect(isToolAutoApproved("vscode-editor-tools__editor_undo_last_edit", settings)).toBe(false)
	})

	it("still auto-approves Forge read tools when the MCP toggle is on", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useMcp: true },
		}

		expect(isToolAutoApproved("vscode-editor-tools__editor_read_file", settings)).toBe(true)
	})
})

describe("isForgeWriteTool", () => {
	it("recognises the edit tools behind the MCP server prefix", () => {
		expect(isForgeWriteTool("vscode-editor-tools__editor_propose_edit")).toBe(true)
		expect(isForgeWriteTool("editor_propose_edit")).toBe(true)
		expect(isForgeWriteTool("vscode-editor-tools__editor_undo_last_edit")).toBe(true)
	})

	it("does not classify read tools or unrelated MCP tools as writes", () => {
		expect(isForgeWriteTool("vscode-editor-tools__editor_read_file")).toBe(false)
		expect(isForgeWriteTool("firecrawl__scrape")).toBe(false)
	})
})
