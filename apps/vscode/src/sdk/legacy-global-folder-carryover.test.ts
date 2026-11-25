import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { carryOverLegacyGlobalFolder, runLegacyGlobalFolderCarryOver } from "./legacy-global-folder-carryover"

let documents: string
let oldRoot: string
let newRoot: string

function write(root: string, relativePath: string, content: string): string {
	const filePath = join(root, relativePath)
	mkdirSync(dirname(filePath), { recursive: true })
	writeFileSync(filePath, content)
	return filePath
}

function memoryState(initial: Record<string, unknown> = {}) {
	const values = { ...initial }
	return {
		values,
		get: <T>(key: string) => values[key] as T | undefined,
		update: async (key: string, value: unknown) => {
			values[key] = value
		},
	}
}

beforeEach(() => {
	documents = mkdtempSync(join(tmpdir(), "legacy-carryover-"))
	oldRoot = join(documents, "Webwork", "cline-cubed", "Cline")
	newRoot = join(documents, "Cline")
})

afterEach(() => {
	rmSync(documents, { recursive: true, force: true })
})

describe("carryOverLegacyGlobalFolder", () => {
	it("does nothing when the old folder does not exist", async () => {
		const result = await carryOverLegacyGlobalFolder(documents)

		expect(result).toEqual({ copied: [], identical: [], conflicts: [], failures: [] })
		expect(existsSync(newRoot)).toBe(false)
	})

	it("copies rules, workflows, hooks, and agents and leaves the originals", async () => {
		const originals = ["Rules/a.md", "Workflows/b.md", "Hooks/PreToolUse", "Agents/c.yaml", "Rules/nested/d.md"].map((name) =>
			write(oldRoot, name, name),
		)

		const result = await carryOverLegacyGlobalFolder(documents)

		expect(result.copied.sort()).toEqual(
			["Agents/c.yaml", "Hooks/PreToolUse", "Rules/a.md", "Rules/nested/d.md", "Workflows/b.md"].sort(),
		)
		expect(readFileSync(join(newRoot, "Rules/nested/d.md"), "utf8")).toBe("Rules/nested/d.md")
		for (const original of originals) {
			expect(existsSync(original)).toBe(true)
		}
	})

	it.skipIf(process.platform === "win32")("keeps a hook script executable", async () => {
		const hook = write(oldRoot, "Hooks/PreToolUse", "#!/bin/sh\n")
		chmodSync(hook, 0o755)

		await carryOverLegacyGlobalFolder(documents)

		expect(statSync(join(newRoot, "Hooks/PreToolUse")).mode & 0o777).toBe(0o755)
	})

	it("never overwrites, and reports a same-named file with different content", async () => {
		write(oldRoot, "Rules/a.md", "old")
		const existing = write(newRoot, "Rules/a.md", "new")

		const result = await carryOverLegacyGlobalFolder(documents)

		expect(result.conflicts).toEqual(["Rules/a.md"])
		expect(result.copied).toEqual([])
		expect(readFileSync(existing, "utf8")).toBe("new")
		expect(readFileSync(join(oldRoot, "Rules/a.md"), "utf8")).toBe("old")
	})

	it("skips a same-named identical file without a conflict", async () => {
		write(oldRoot, "Rules/a.md", "same")
		write(newRoot, "Rules/a.md", "same")

		const result = await carryOverLegacyGlobalFolder(documents)

		expect(result.identical).toEqual(["Rules/a.md"])
		expect(result.conflicts).toEqual([])
	})

	it("leaves MCP, Worktrees, and Finder metadata alone", async () => {
		write(oldRoot, "MCP/server/index.js", "server")
		write(oldRoot, "Worktrees/app-1/file.txt", "tree")
		write(oldRoot, "Rules/.DS_Store", "meta")

		const result = await carryOverLegacyGlobalFolder(documents)

		expect(result.copied).toEqual([])
		expect(existsSync(join(newRoot, "MCP"))).toBe(false)
		expect(existsSync(join(newRoot, "Worktrees"))).toBe(false)
		expect(existsSync(join(newRoot, "Rules/.DS_Store"))).toBe(false)
	})

	it("reports a failure and keeps copying the rest", async () => {
		write(oldRoot, "Rules/a.md", "a")
		write(oldRoot, "Workflows/b.md", "b")
		write(documents, "Cline/Rules", "a file where the folder belongs")

		const result = await carryOverLegacyGlobalFolder(documents)

		expect(result.failures).toEqual(["Rules/a.md"])
		expect(result.copied).toEqual(["Workflows/b.md"])
	})
})

describe("runLegacyGlobalFolderCarryOver", () => {
	it("runs once, so a copy the user deletes is not brought back", async () => {
		write(oldRoot, "Rules/a.md", "a")
		const state = memoryState()
		const notify = vi.fn()

		await runLegacyGlobalFolderCarryOver(state, documents, notify)
		rmSync(join(newRoot, "Rules/a.md"))
		await runLegacyGlobalFolderCarryOver(state, documents, notify)

		expect(existsSync(join(newRoot, "Rules/a.md"))).toBe(false)
		expect(notify).not.toHaveBeenCalled()
	})

	it("names a conflict in a warning and still completes", async () => {
		write(oldRoot, "Rules/a.md", "old")
		write(newRoot, "Rules/a.md", "new")
		const state = memoryState()
		const notify = vi.fn()

		await runLegacyGlobalFolderCarryOver(state, documents, notify)

		expect(notify).toHaveBeenCalledTimes(1)
		expect(notify.mock.calls[0][0]).toContain("Rules/a.md")
		expect(Object.values(state.values)).toEqual([true])
	})

	it("retries on the next start after a failure", async () => {
		write(oldRoot, "Rules/a.md", "a")
		const blocker = write(documents, "Cline/Rules", "blocks the folder")
		const state = memoryState()
		const notify = vi.fn()

		await runLegacyGlobalFolderCarryOver(state, documents, notify)
		expect(Object.values(state.values)).toEqual([])
		expect(notify).toHaveBeenCalledTimes(1)

		rmSync(blocker)
		await runLegacyGlobalFolderCarryOver(state, documents, notify)

		expect(readFileSync(join(newRoot, "Rules/a.md"), "utf8")).toBe("a")
		expect(Object.values(state.values)).toEqual([true])
	})
})
