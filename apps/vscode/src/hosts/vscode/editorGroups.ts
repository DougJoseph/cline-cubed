import * as vscode from "vscode"
import { isChatPanelTab } from "@/hosts/vscode/chatEditorPanel"

/**
 * Cline Cubed: two named editor groups — one "For Chats", one "For Files" (Doug's design
 * ruling, 2026-08-30; plan: Docs/2026-08-30_10.33pm_two-named-editor-groups-chats-and-files.md).
 *
 * Chats never land among the user's files, and files never muddy the chats group. The two
 * halves are deliberately asymmetric:
 *
 *   - the CHATS group derives itself, every time, from what is on screen (the group whose tabs
 *     are all chat panels). Nothing is stored, so it survives a reload, a drag, a close and a
 *     reinstall for free;
 *   - the FILES group is CHOSEN from what exists, remembered only as a hint, and re-validated
 *     on every use.
 *
 * Why a hint and not an identity: VS Code gives extensions no group id that survives anything.
 * A group is addressed by `ViewColumn` — a POSITION, which shifts when groups are added,
 * closed, moved or merged — or by an object in `window.tabGroups.all`, which does not survive a
 * window reload. So the designation is re-derived, and only the last answer is remembered.
 *
 * Lock state is deliberately absent from all of this: `vscode.TabGroup` exposes `isActive`,
 * `viewColumn`, `activeTab` and `tabs`, and nothing else. Locking is a workbench command we can
 * ISSUE and never READ (plan amendment, 2026-08-31). "Not the chats group" already covers every
 * lock we apply — the only one we ever apply is to a chat column we just created — and if a
 * file is ever aimed at a group the user locked by hand, VS Code re-routes it to an unlocked
 * group on its own, so the miss costs nothing.
 */

/** Where the remembered files column lives. `extension.ts` owns the real workspaceState. */
export interface FilesColumnStore {
	get(): number | undefined
	set(column: number): void
}

let filesColumnStore: FilesColumnStore | undefined

/**
 * Wired once at activation. `ClineExtensionContext` deliberately hides `workspaceState`, so
 * every host-side use of it is threaded in from `extension.ts` — the same shape the chat-layout
 * persistence uses.
 */
export function setFilesColumnStore(store: FilesColumnStore | undefined): void {
	filesColumnStore = store
}

/** The group whose tabs are ALL chat panels, if one is open. */
export function chatsGroupColumn(): vscode.ViewColumn | undefined {
	const group = vscode.window.tabGroups.all.find((g) => g.tabs.length > 0 && g.tabs.every(isChatPanelTab))
	return group?.viewColumn
}

/**
 * Is this tab an actual DOCUMENT — something a person edits or reads as a file?
 *
 * Everything else a tab can hold (a webview, a terminal, an interactive window) is somebody's
 * PANEL. The distinction is what keeps the files group away from other extensions' chats:
 * Claude's chat is a webview exactly as ours is, so counting "not one of our chat panels" as
 * "a file" let a group holding a Claude chat win the files slot (Doug's test, 2026-08-31).
 */
function isDocumentTab(tab: vscode.Tab): boolean {
	const input = tab.input
	return (
		input instanceof vscode.TabInputText ||
		input instanceof vscode.TabInputTextDiff ||
		input instanceof vscode.TabInputCustom ||
		input instanceof vscode.TabInputNotebook ||
		input instanceof vscode.TabInputNotebookDiff
	)
}

/** A group holding no webview of any kind — ours, another extension's, anyone's. */
function holdsNoPanels(group: vscode.TabGroup): boolean {
	return !group.tabs.some((tab) => tab.input instanceof vscode.TabInputWebview)
}

/**
 * Can this group hold files at all? Not the chats group, and not a group that is nothing but
 * panels — a group holding only a Claude chat is that person's chat window, not a filing spot.
 * An EMPTY group is fine: it holds nothing, so nothing is being intruded on.
 */
function couldHoldFiles(group: vscode.TabGroup, chatsColumn: vscode.ViewColumn | undefined): boolean {
	if (group.viewColumn === chatsColumn) {
		return false
	}
	return group.tabs.length === 0 || group.tabs.some(isDocumentTab)
}

/**
 * The column a file should open in. Resolution order (plan §2a, amended 2026-08-31):
 *
 *   1. the remembered column, if its group still exists and could still hold files;
 *   2. otherwise, in preference order:
 *      a. a group of documents with NO panels in it — the plainest "files" group there is,
 *         most documents winning, so an established files group beats an incidental one;
 *      b. an empty group with no panels — room already open, intruding on nobody;
 *      c. a group that has documents but also holds someone's panel — acceptable, but last;
 *   3. otherwise `Beside`, which VS Code turns into a new group. This is also the first-run
 *      case, when a chat is the only thing open.
 *
 * Whichever step answers, the result is remembered, so the choice is sticky rather than
 * re-litigated per file. `Beside` is NOT remembered — it names no column.
 */
export function filesViewColumn(): vscode.ViewColumn {
	const chatsColumn = chatsGroupColumn()
	const groups = vscode.window.tabGroups.all.filter((group) => couldHoldFiles(group, chatsColumn))

	const remembered = filesColumnStore?.get()
	if (remembered !== undefined && groups.some((group) => group.viewColumn === remembered)) {
		return remembered as vscode.ViewColumn
	}

	const rank = (group: vscode.TabGroup): number => {
		const documents = group.tabs.filter(isDocumentTab).length
		if (documents > 0) {
			return holdsNoPanels(group) ? 2 : 0
		}
		return holdsNoPanels(group) ? 1 : -1
	}

	let best: vscode.TabGroup | undefined
	let bestKey = [-1, -1]
	for (const group of groups) {
		const key = [rank(group), group.tabs.filter(isDocumentTab).length]
		if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
			best = group
			bestKey = key
		}
	}
	if (best) {
		filesColumnStore?.set(best.viewColumn)
		return best.viewColumn
	}

	return vscode.ViewColumn.Beside
}
