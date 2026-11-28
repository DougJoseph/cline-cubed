import { strict as assert } from "node:assert"
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { beforeEach, describe, it, vi } from "vitest"

const { dialog, messages, opened } = vi.hoisted(() => ({
	// The files opened in an editor, and the files shown in the file manager.
	opened: { editor: [] as string[], revealed: [] as string[] },
	// What the folder dialog is asked for, and what it hands back.
	dialog: { request: undefined as any, paths: [] as string[] },
	// Every message shown, and the button the next confirmation answers with.
	messages: { shown: [] as any[], answer: undefined as string | undefined },
}))

vi.mock("@/hosts/host-provider", () => ({
	HostProvider: {
		window: {
			showOpenDialogue: async (request: any) => {
				dialog.request = request
				return { paths: dialog.paths }
			},
			showMessage: async (request: any) => {
				messages.shown.push(request)
				return { selectedOption: request.options?.modal ? messages.answer : request.options?.items?.[0] }
			},
			openFile: async (request: any) => {
				opened.editor.push(request.filePath)
				return {}
			},
			revealFileInOs: async (request: any) => {
				opened.revealed.push(request.filePath)
				return {}
			},
		},
	},
}))

vi.mock("@/core/storage/documents-path", () => ({
	getDocumentsPath: async () => "/Users/tester/Documents",
}))

vi.mock("@/shared/services/Logger", () => ({
	Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

// No saved Relay URL, so the export asks no relay whether it is installed: a test never reaches a live
// server through this machine's own settings.
vi.mock("@cline/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cline/core")>()),
	readRelaySettingsGlobally: () => ({ url: "", key: "", pollIntervalMs: 1500 }),
}))

import { exportRelayBundle } from "./exportRelayBundle"

let folder: string

beforeEach(() => {
	folder = mkdtempSync(path.join(os.tmpdir(), "relay-installer-"))
	dialog.request = undefined
	dialog.paths = []
	messages.shown = []
	messages.answer = undefined
	opened.editor = []
	opened.revealed = []
})

/** Whether a file can be read by a user other than its owner, which a web server needs. */
const readableByOthers = (file: string): boolean => (statSync(file).mode & 0o004) !== 0

describe("exportRelayBundle", () => {
	it("asks for a folder, starting at Documents, and writes index.php and INSTALL.txt into it", async () => {
		dialog.paths = [folder]

		const result = await exportRelayBundle(undefined as any, undefined as any)

		assert.equal(dialog.request.canSelectFolders, true, JSON.stringify(dialog.request))
		assert.equal(dialog.request.canSelectFiles, false)
		assert.equal(dialog.request.defaultPath, "/Users/tester/Documents")
		assert.equal(result.error, "")
		assert.equal(result.path, folder)
		assert.deepEqual(result.files, [path.join(folder, "index.php"), path.join(folder, "INSTALL.txt")])
		assert.ok(readFileSync(path.join(folder, "index.php"), "utf8").startsWith("<?php"))
		assert.ok(readFileSync(path.join(folder, "INSTALL.txt"), "utf8").startsWith("# Cline Cubed remote-control relay"))
		assert.equal(result.installToken.length, 32)
	})

	it("writes both files readable by a web server", async () => {
		dialog.paths = [folder]

		await exportRelayBundle(undefined as any, undefined as any)

		assert.ok(readableByOthers(path.join(folder, "index.php")), "index.php must be readable by others")
		assert.ok(readableByOthers(path.join(folder, "INSTALL.txt")), "INSTALL.txt must be readable by others")
	})

	it("shows a notice naming both files and the folder", async () => {
		dialog.paths = [folder]

		await exportRelayBundle(undefined as any, undefined as any)

		const notice = messages.shown.find((message) => !message.options?.modal)
		assert.ok(notice, "a notice is shown")
		assert.ok(
			notice.message.includes("index.php") && notice.message.includes("INSTALL.txt") && notice.message.includes(folder),
		)
		assert.equal(notice.options.items.length, 1, "it offers to show the files")
	})

	it("opens INSTALL.txt in an editor, and the notice's button shows index.php in the file manager", async () => {
		dialog.paths = [folder]

		await exportRelayBundle(undefined as any, undefined as any)
		await new Promise((resolve) => setTimeout(resolve, 0))

		assert.deepEqual(opened.editor, [path.join(folder, "INSTALL.txt")])
		assert.deepEqual(opened.revealed, [path.join(folder, "index.php")])
	})

	it("writes nothing when the dialog is cancelled", async () => {
		const result = await exportRelayBundle(undefined as any, undefined as any)

		assert.equal(result.error, "cancelled")
		assert.equal(result.path, "")
		assert.equal(messages.shown.length, 0, "a cancelled dialog says nothing")
		assert.equal(opened.editor.length, 0, "and opens nothing")
	})

	it("asks before replacing an existing file, and writes nothing when declined", async () => {
		dialog.paths = [folder]
		writeFileSync(path.join(folder, "index.php"), "mine")

		const result = await exportRelayBundle(undefined as any, undefined as any)

		assert.equal(messages.shown[0]?.options?.modal, true, "the replace question is asked first")
		assert.equal(result.error, "cancelled")
		assert.equal(readFileSync(path.join(folder, "index.php"), "utf8"), "mine")
		assert.equal(existsSync(path.join(folder, "INSTALL.txt")), false)
	})

	it("replaces existing files when the user agrees", async () => {
		dialog.paths = [folder]
		writeFileSync(path.join(folder, "index.php"), "mine")
		messages.answer = "Replace"

		const result = await exportRelayBundle(undefined as any, undefined as any)

		assert.equal(result.error, "")
		assert.ok(readFileSync(path.join(folder, "index.php"), "utf8").startsWith("<?php"))
	})
})
