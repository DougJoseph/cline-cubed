import { beforeEach, describe, expect, it } from "vitest"
import * as vscode from "vscode"
import { isChatPanelTab } from "./chatEditorPanel"
import { chatsGroupColumn, filesViewColumn, setFilesColumnStore } from "./editorGroups"

/**
 * Cline Cubed: two named editor groups — one "For Chats", one "For Files" (Doug's design ruling,
 * 2026-08-30; plan: Docs/2026-08-30_10.33pm_two-named-editor-groups-chats-and-files.md).
 */

/** The prefix VS Code puts on every extension webview's view type before reporting it on a tab. */
const HOST_PREFIX = "mainThreadWebview-"
const CHAT_VIEW_TYPE = "cline-cubed-ChatPanel"

const chatTab = () => ({ input: new vscode.TabInputWebview(HOST_PREFIX + CHAT_VIEW_TYPE) })
const fileTab = () => ({ input: new vscode.TabInputText(vscode.Uri.file("/tmp/a.ts")) })

function setGroups(...groups: Array<{ column: number; tabs: unknown[] }>): void {
	;(vscode.window.tabGroups as unknown as { all: unknown[] }).all = groups.map((group) => ({
		viewColumn: group.column,
		tabs: group.tabs,
		isActive: false,
		activeTab: group.tabs[0],
	}))
}

/** A store that records what the resolver remembered, so stickiness is assertable. */
function trackingStore(initial?: number) {
	const state: { column?: number; writes: number[] } = { column: initial, writes: [] }
	setFilesColumnStore({
		get: () => state.column,
		set: (column) => {
			state.column = column
			state.writes.push(column)
		},
	})
	return state
}

beforeEach(() => {
	setGroups()
	setFilesColumnStore(undefined)
})

describe("isChatPanelTab", () => {
	// The regression this guards: an equality test against the raw view type matched NOTHING,
	// because VS Code reports it prefixed — so chats never grouped and each one took, and
	// locked, a column of its own.
	it("recognises a chat tab through the host's view-type prefix", () => {
		expect(isChatPanelTab(chatTab() as vscode.Tab)).toBe(true)
	})

	it("still recognises an unprefixed view type, in case a host reports the raw one", () => {
		const raw = { input: new vscode.TabInputWebview(CHAT_VIEW_TYPE) }
		expect(isChatPanelTab(raw as vscode.Tab)).toBe(true)
	})

	it("does not mistake another extension's webview for a chat", () => {
		const other = { input: new vscode.TabInputWebview(`${HOST_PREFIX}someoneElse.panel`) }
		expect(isChatPanelTab(other as vscode.Tab)).toBe(false)
	})

	it("does not mistake a file for a chat", () => {
		expect(isChatPanelTab(fileTab() as vscode.Tab)).toBe(false)
	})
})

describe("chatsGroupColumn", () => {
	it("finds the group whose tabs are all chats", () => {
		setGroups({ column: 1, tabs: [fileTab()] }, { column: 2, tabs: [chatTab(), chatTab()] })
		expect(chatsGroupColumn()).toBe(2)
	})

	it("is undefined when no chat is open in the editor area", () => {
		setGroups({ column: 1, tabs: [fileTab()] })
		expect(chatsGroupColumn()).toBeUndefined()
	})

	it("does not count an empty group — an empty group is not a chats group", () => {
		setGroups({ column: 1, tabs: [] })
		expect(chatsGroupColumn()).toBeUndefined()
	})

	it("does not count a group the user dropped a file into — it is no longer chats-only", () => {
		setGroups({ column: 1, tabs: [chatTab(), fileTab()] })
		expect(chatsGroupColumn()).toBeUndefined()
	})
})

describe("filesViewColumn", () => {
	it("uses the remembered column when it still exists, and leaves it alone", () => {
		const store = trackingStore(3)
		setGroups({ column: 1, tabs: [fileTab(), fileTab()] }, { column: 3, tabs: [fileTab()] })
		expect(filesViewColumn()).toBe(3)
		expect(store.writes).toEqual([])
	})

	it("re-chooses when the remembered group has been closed, and remembers the new one", () => {
		const store = trackingStore(9)
		setGroups({ column: 1, tabs: [fileTab()] }, { column: 2, tabs: [fileTab(), fileTab()] })
		expect(filesViewColumn()).toBe(2)
		expect(store.column).toBe(2)
	})

	it("re-chooses when the remembered column is now the chats group", () => {
		const store = trackingStore(2)
		setGroups({ column: 1, tabs: [fileTab()] }, { column: 2, tabs: [chatTab()] })
		expect(filesViewColumn()).toBe(1)
		expect(store.column).toBe(1)
	})

	it("prefers the group holding the most files — an established files group beats an incidental one", () => {
		trackingStore()
		setGroups(
			{ column: 1, tabs: [fileTab()] },
			{ column: 2, tabs: [fileTab(), fileTab(), fileTab()] },
			{ column: 3, tabs: [] },
		)
		expect(filesViewColumn()).toBe(2)
	})

	it("never answers with the chats group, even when it is the only group holding tabs", () => {
		trackingStore()
		setGroups({ column: 1, tabs: [chatTab(), chatTab()] })
		expect(filesViewColumn()).toBe(vscode.ViewColumn.Beside)
	})

	it("does not remember Beside — it names no column", () => {
		const store = trackingStore()
		setGroups({ column: 1, tabs: [chatTab()] })
		expect(filesViewColumn()).toBe(vscode.ViewColumn.Beside)
		expect(store.column).toBeUndefined()
	})

	it("falls through to Beside on a first run, with no groups open at all", () => {
		trackingStore()
		expect(filesViewColumn()).toBe(vscode.ViewColumn.Beside)
	})

	it("still resolves when no store is wired — the hint is an optimisation, not a dependency", () => {
		setGroups({ column: 4, tabs: [fileTab()] })
		expect(filesViewColumn()).toBe(4)
	})
})

describe("filesViewColumn — other extensions' chats are panels, not files", () => {
	// Doug's test, 2026-08-31: his Cline Cubed file opens landed in the group holding his
	// CLAUDE chat, because the first cut scored "tabs that are not OUR chat" as files — and a
	// Claude chat is a webview exactly as ours is.
	const claudeTab = () => ({ input: new vscode.TabInputWebview("mainThreadWebview-claudeVSCodePanel") })

	it("never picks a group that holds only another extension's chat", () => {
		trackingStore()
		setGroups({ column: 1, tabs: [chatTab()] }, { column: 2, tabs: [claudeTab()] })
		expect(filesViewColumn()).toBe(vscode.ViewColumn.Beside)
	})

	it("prefers a plain documents group over one that also holds someone's chat", () => {
		trackingStore()
		setGroups({ column: 1, tabs: [claudeTab(), fileTab(), fileTab(), fileTab()] }, { column: 2, tabs: [fileTab()] })
		expect(filesViewColumn()).toBe(2)
	})

	it("prefers an empty group over a group holding someone's chat", () => {
		trackingStore()
		setGroups({ column: 1, tabs: [claudeTab(), fileTab()] }, { column: 2, tabs: [] })
		expect(filesViewColumn()).toBe(2)
	})

	it("will use a mixed group when it is the only place documents live", () => {
		trackingStore()
		setGroups({ column: 1, tabs: [claudeTab(), fileTab()] })
		expect(filesViewColumn()).toBe(1)
	})

	it("re-chooses when the remembered group has become all panels", () => {
		const store = trackingStore(1)
		setGroups({ column: 1, tabs: [claudeTab()] }, { column: 2, tabs: [fileTab()] })
		expect(filesViewColumn()).toBe(2)
		expect(store.column).toBe(2)
	})

	it("counts diffs and notebooks as documents, not panels", () => {
		trackingStore()
		const diff = { input: new vscode.TabInputTextDiff(vscode.Uri.file("/a"), vscode.Uri.file("/b")) }
		const notebook = { input: new vscode.TabInputNotebook(vscode.Uri.file("/n.ipynb"), "jupyter") }
		setGroups({ column: 1, tabs: [claudeTab()] }, { column: 3, tabs: [diff, notebook] })
		expect(filesViewColumn()).toBe(3)
	})
})
