import {
	bindChatSurfaceToSession,
	chatSurfaceForSession,
	getActiveChatSurface,
	onChatTitleChanged,
	registerChatSurface,
	setActiveChatSurface,
	setChatSurfaceEvictionNotifier,
	unregisterChatSurface,
} from "@core/controller/chat-surfaces"
import { mintSurfaceId } from "@core/webview/WebviewProvider"
import { NewChatLocation } from "@shared/storage/types"
import * as vscode from "vscode"
import { handleGrpcRequest, handleGrpcRequestCancel } from "@/core/controller/grpc-handler"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import type { ExtensionMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { WebviewMessage } from "@/shared/WebviewMessage"
import { VscodeWebviewProvider } from "./VscodeWebviewProvider"

const CHAT_PANEL_VIEW_TYPE = "cline-cubed-ChatPanel"

/** What an editor chat tab is called before it holds a chat — a New Chat tab, sitting on the home. */
const CHAT_PANEL_DEFAULT_TITLE = "Cline Cubed"
/** Tab titles are one short line; VS Code shrinks the strip further as tabs multiply. */
const CHAT_PANEL_TITLE_MAX = 40

/**
 * Cline Cubed: an editor chat tab's label.
 *
 * Telling side-by-side chat tabs apart is the whole point of naming a chat, so a tab shows its
 * chat's DISPLAY name — the name if it has been renamed, otherwise its first prompt — resolved by
 * the one shared helper every other label surface uses (`chatDisplayTitle`). A tab with no chat in
 * it yet keeps the extension's name.
 *
 * A first prompt is prose: it can be paragraphs long and contain newlines, neither of which a tab
 * strip can show. Whitespace is collapsed to single spaces and the result is truncated, so the tab
 * carries the opening words rather than a wall of text or a mangled one-liner.
 */
export function chatPanelTitle(displayName: string | undefined): string {
	const name = displayName?.replace(/\s+/g, " ").trim()
	if (!name) {
		return CHAT_PANEL_DEFAULT_TITLE
	}
	return name.length > CHAT_PANEL_TITLE_MAX ? `${name.slice(0, CHAT_PANEL_TITLE_MAX - 1).trimEnd()}\u2026` : name
}

/** Handle for posting a targeted host→webview message to ONE chat surface (e.g. showOnboarding):
 *  only the TARGET surface receives it — the other open chats stay untouched. */
export interface ChatSurfaceHandle {
	postMessage(message: ExtensionMessage): void
}

function webviewHandle(webview: vscode.Webview | undefined): ChatSurfaceHandle | undefined {
	if (!webview) {
		return undefined
	}
	return {
		postMessage: (message) => {
			void webview.postMessage(message)
		},
	}
}

/** Editor chat panels bound to a task/session id (mirrors Claude Code's `sessionPanels`). */
const taskChatPanels = new Map<string, vscode.WebviewPanel>()
/** A "new chat" panel not yet tied to a task; claimed by the next session opened in the editor. */
let unboundChatPanel: vscode.WebviewPanel | undefined
/** The task id each editor panel is bound to, for resume-on-focus (multi-chat tabs). */
const panelTaskIds = new WeakMap<vscode.WebviewPanel, string>()
/** Cline Cubed: each editor chat panel's routing id, so state/transcript are addressed to it. */
const panelSurfaceIds = new WeakMap<vscode.WebviewPanel, string>()

/** Cline Cubed: the routing id of an editor chat panel. */
export function surfaceIdForChatPanel(panel: vscode.WebviewPanel): string | undefined {
	return panelSurfaceIds.get(panel)
}

/**
 * Cline Cubed: put a chat's name on its tab.
 *
 * Asynchronous because the name is resolved from task history. The binding is re-checked after the
 * lookup: a tab can be rebound (or closed) while the read is in flight, and a late answer must not
 * relabel a tab that has since moved on. A failed lookup leaves the tab as it is.
 */
async function applyChatPanelTitle(panel: vscode.WebviewPanel, provider: VscodeWebviewProvider, taskId: string): Promise<void> {
	try {
		const displayName = await provider.controller.getChatDisplayTitle(taskId)
		const next = chatPanelTitle(displayName)
		// Still this tab's chat, and actually different: the notification also rides ordinary
		// history writes, most of which do not change the name at all.
		if (panelTaskIds.get(panel) === taskId && panel.title !== next) {
			panel.title = next
		}
	} catch (error) {
		Logger.error("Failed to read a chat's name for its editor tab:", error)
	}
}

/**
 * Cline Cubed: record that an editor tab now shows a given session, and label the tab with it.
 *
 * The two bookkeeping maps and the tab title are one fact stated three ways, so they are written
 * in one place — they drifted apart when only the open-a-known-session path maintained them, which
 * left a chat STARTED in a tab absent from `taskChatPanels` entirely.
 */
function bindChatPanelToTask(panel: vscode.WebviewPanel, provider: VscodeWebviewProvider, taskId: string): void {
	panelTaskIds.set(panel, taskId)
	taskChatPanels.set(taskId, panel)
	if (unboundChatPanel === panel) {
		unboundChatPanel = undefined
	}
	void applyChatPanelTitle(panel, provider, taskId)
}

/** Cline Cubed: the tab no longer shows a chat — drop its claim and return it to the default name. */
function releaseChatPanelTask(panel: vscode.WebviewPanel): void {
	const previousTaskId = panelTaskIds.get(panel)
	if (previousTaskId !== undefined && taskChatPanels.get(previousTaskId) === panel) {
		taskChatPanels.delete(previousTaskId)
	}
	panelTaskIds.delete(panel)
	panel.title = CHAT_PANEL_DEFAULT_TITLE
	// Deliberately NOT claiming the `unboundChatPanel` slot. That slot only decides whether opening
	// a session REUSES an empty tab instead of making a new one, and this function runs on paths
	// that never claimed it before — changing that would quietly redirect where the next chat opens.
}

/**
 * Opens (or focuses) the chat webview PANEL in the editor area (a tab in the editor tab
 * strip), mirroring Claude Code's `claudeVSCodePanel`. It loads the same webview bundle in
 * "chat" mode and bridges gRPC messages to the shared controller, exactly like the sidebar
 * chat webview.
 *
 * v2 rework (2026-08-26, per the Claude Code comparison): per-task panels (a session's panel
 * is revealed on reopen instead of duplicating), a new/locked editor column instead of
 * stealing `ViewColumn.Active`, `enableFindWidget`, and a `{light, dark}` icon.
 */
export function openChatInEditorPanel(
	context: { extensionUri: vscode.Uri },
	provider: VscodeWebviewProvider,
	options: { taskId?: string; column?: vscode.ViewColumn } = {},
): vscode.WebviewPanel {
	const { taskId, column } = options

	// A task-bound panel is already open → reveal it (mirror Claude's `sessionPanels` reveal).
	if (taskId) {
		const existing = taskChatPanels.get(taskId)
		if (existing) {
			existing.reveal()
			return existing
		}
	}

	let panel: vscode.WebviewPanel
	if (taskId && unboundChatPanel) {
		// A "new chat" panel is still open and unbound — bind it to this task instead of
		// spawning a second panel for the same conversation.
		panel = unboundChatPanel
		unboundChatPanel = undefined
	} else {
		panel = createChatPanel(context, provider, column, taskId)
	}

	if (taskId) {
		bindChatPanelToTask(panel, provider, taskId)
		// Cline Cubed: this panel now shows that session; any other surface claiming it releases it.
		const surfaceId = panelSurfaceIds.get(panel)
		if (surfaceId) {
			bindChatSurfaceToSession(surfaceId, taskId)
		}
	} else {
		unboundChatPanel = panel
	}
	return panel
}

function createChatPanel(
	context: { extensionUri: vscode.Uri },
	provider: VscodeWebviewProvider,
	column?: vscode.ViewColumn,
	taskId?: string,
): vscode.WebviewPanel {
	// Column choice mirrors Claude's `editor.open`: only an EXPLICIT column request (the
	// "primary editor" command) uses `ViewColumn.Active`; otherwise pick a chat-friendly
	// column and lock it when it's brand new.
	const { viewColumn, startedInNewColumn } =
		column !== undefined ? { viewColumn: column, startedInNewColumn: false } : pickChatPanelColumn()

	const panel = vscode.window.createWebviewPanel(
		CHAT_PANEL_VIEW_TYPE,
		"Cline Cubed",
		{ viewColumn, preserveFocus: false },
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			enableFindWidget: true,
			localResourceRoots: [vscode.Uri.file(HostProvider.get().extensionFsPath)],
		},
	)
	// Nav-bar mark: the compact icon used on chrome (tab strip, sidebars), not the large
	// marketplace/home mark.
	const iconUri = vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "icon.svg")
	const iconDarkUri = vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "icon-dark.svg")
	panel.iconPath = { light: iconUri, dark: iconDarkUri }

	// Resource URLs must be built against THIS panel's webview (each webview has its own
	// origin), so pass a target accessor — not the provider's own webview.
	// Cline Cubed: the panel is registered and identified in its HTML before the bundle loads,
	// so it renders its own session from the first frame. With no taskId it starts unbound and
	// shows the home; a task-bound panel boots already bound to its session.
	const surfaceId = mintSurfaceId("editor-panel")
	panelSurfaceIds.set(panel, surfaceId)
	registerChatSurface(surfaceId, taskId ?? null)
	// If this tab's session is reopened elsewhere (evicted), clear the tab's task claim FIRST —
	// otherwise focusing the tab would re-bind the session and steal it right back — then tell
	// the webview to step back to the home rather than freeze on a stale copy of the moved chat.
	setChatSurfaceEvictionNotifier(surfaceId, () => {
		releaseChatPanelTask(panel)
		void panel.webview.postMessage({ type: "showNewChatHome" })
	})
	// A new panel opens focused — it is the chat in front of the user from creation.
	setActiveChatSurface(surfaceId)
	panel.webview.html = provider.getHtmlContent(
		{
			cspSource: panel.webview.cspSource,
			webviewUrlForPath: (assetPath) => panel.webview.asWebviewUri(vscode.Uri.file(assetPath)).toString(),
		},
		{ surfaceId, sessionId: taskId ?? null },
	)

	const postMessageToWebview = (response: ExtensionMessage) => panel.webview.postMessage(response)
	const messageListener = panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
		switch (message.type) {
			case "grpc_request": {
				if (message.grpc_request) {
					await handleGrpcRequest(provider.controller, postMessageToWebview, message.grpc_request, surfaceId)
				}
				break
			}
			case "grpc_request_cancel": {
				if (message.grpc_request_cancel) {
					await handleGrpcRequestCancel(postMessageToWebview, message.grpc_request_cancel)
				}
				break
			}
			case "bindSurfaceSession": {
				// Cline Cubed: this surface now shows that session — deliver its state and
				// transcript here, and release any other surface that was claiming it.
				bindChatSurfaceToSession(surfaceId, message.sessionId ?? null)
				if (typeof message.sessionId === "string") {
					// This is where a chat STARTED in a tab becomes a real session: the tab opened
					// unbound on the home, and the first prompt created the session announced here.
					// So the tab's own bookkeeping and its label are set from this message too, not
					// only from the open-a-known-session path.
					bindChatPanelToTask(panel, provider, message.sessionId)
					// A surface binding AFTER a session's opening state post would miss that
					// snapshot — repost that session's state so the first render cannot be skipped.
					await provider.controller.postStateToWebview(message.sessionId)
				} else {
					// Unbound again (the in-chat close): the tab is back on the home, so it drops
					// its task claim and its name with it.
					releaseChatPanelTask(panel)
				}
				break
			}
			case "dismissOnboarding": {
				// Leave the "Cline Cubed: Get Started" re-view without flipping welcomeViewCompleted.
				provider.controller.stateManager.setGlobalState("clineCubedShowOnboarding", false)
				await provider.controller.postStateToWebview()
				break
			}
			default: {
				Logger.error("Received unhandled WebviewMessage type in editor chat panel:", JSON.stringify(message))
			}
		}
	})
	// Cline Cubed: renaming a chat anywhere — its own header, or a row in any history list —
	// relabels the tab showing it. Scoped per panel and read at fire time from `panelTaskIds`,
	// because a tab's chat changes over its life; disposed with the panel, so no listener outlives
	// its tab.
	const titleListener = onChatTitleChanged((changedTaskId) => {
		if (panelTaskIds.get(panel) === changedTaskId) {
			void applyChatPanelTitle(panel, provider, changedTaskId)
		}
	})

	panel.onDidDispose(() => {
		messageListener.dispose()
		titleListener()
		unregisterChatSurface(surfaceId)
		for (const [boundTaskId, p] of taskChatPanels) {
			if (p === panel) {
				taskChatPanels.delete(boundTaskId)
			}
		}
		if (unboundChatPanel === panel) {
			unboundChatPanel = undefined
		}
	})

	// Cline Cubed: each editor tab renders its OWN session, because state and transcript are
	// delivered per surface. Focusing a tab therefore only re-asserts that binding — it must not
	// switch the shared controller's task, which would interrupt whichever chat is streaming.
	panel.onDidChangeViewState(({ webviewPanel }) => {
		if (!webviewPanel.active) {
			return
		}
		const focusedSurfaceId = panelSurfaceIds.get(webviewPanel)
		if (focusedSurfaceId) {
			// Cline Cubed: this tab is now the chat the user is working in.
			setActiveChatSurface(focusedSurfaceId)
		}
		const boundTaskId = panelTaskIds.get(webviewPanel)
		if (boundTaskId && focusedSurfaceId) {
			bindChatSurfaceToSession(focusedSurfaceId, boundTaskId)
		}
	})

	// Mirror Claude's `editor.open`: a brand-new column gets locked so opening files can't
	// overwrite the chat tab.
	if (startedInNewColumn) {
		void vscode.commands.executeCommand("workbench.action.lockEditorGroup")
		// A webview panel has no width of its own — it fills its editor group, and a brand-new
		// group is sized by whatever VS Code's split gives it (about half the editor area when
		// there was one group, a third when there were two, and so on). That is why a new chat
		// could arrive very wide or oddly narrow depending only on the layout at that moment.
		// Evening the widths makes a new chat group match the others instead (Doug, 2026-08-28).
		void vscode.commands.executeCommand("workbench.action.evenEditorWidths")
	}

	return panel
}

/**
 * Mirrors Claude's `createPanel` column choice: reuse a column that is already entirely
 * chat panels (group the chats together), else pick a column with no tabs (`findUnusedColumn`).
 */
function pickChatPanelColumn(): { viewColumn: vscode.ViewColumn; startedInNewColumn: boolean } {
	const chatOnlyGroup = vscode.window.tabGroups.all.find((group) => {
		if (group.tabs.length === 0) {
			return false
		}
		return group.tabs.every(
			(tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType === CHAT_PANEL_VIEW_TYPE,
		)
	})
	if (chatOnlyGroup?.viewColumn !== undefined) {
		return { viewColumn: chatOnlyGroup.viewColumn, startedInNewColumn: false }
	}
	const usedColumns = new Set(vscode.window.tabGroups.all.map((group) => group.viewColumn))
	for (let n = 1; n <= 9; n++) {
		const col = n as vscode.ViewColumn
		if (!usedColumns.has(col)) {
			return { viewColumn: col, startedInNewColumn: true }
		}
	}
	return { viewColumn: vscode.ViewColumn.Beside, startedInNewColumn: true }
}

/**
 * Reveals (and focuses) the chat surface for the given `newChatLocation` setting:
 * - "secondarySidebar" → the right secondary-sidebar chat container (Claude Code layout)
 * - "editor" → the editor-area chat panel tab
 */
export async function revealChatSurface(
	context: { extensionUri: vscode.Uri },
	provider: VscodeWebviewProvider,
	location: NewChatLocation,
	taskId?: string,
): Promise<ChatSurfaceHandle | undefined> {
	return revealChatSurfaceInner(context, provider, location, taskId)
}

async function revealChatSurfaceInner(
	context: { extensionUri: vscode.Uri },
	provider: VscodeWebviewProvider,
	location: NewChatLocation,
	taskId?: string,
): Promise<ChatSurfaceHandle | undefined> {
	switch (location) {
		case "editor": {
			const panel = openChatInEditorPanel(context, provider, taskId ? { taskId } : {})
			return webviewHandle(panel.webview)
		}
		case "secondarySidebar":
		default: {
			await vscode.commands.executeCommand(`workbench.view.extension.${ExtensionRegistryInfo.views.ActivityBarSecondary}`)
			provider.getWebview()?.show(true)
			return webviewHandle(provider.getWebview()?.webview)
		}
	}
}

/**
 * Open an EXISTING session from the chats list.
 *
 * If a surface already shows it, reveal that surface — the chat stays where the user left it and
 * nothing is moved. Otherwise open it in the configured location: an editor tab binds to the
 * session directly, while a sidebar is revealed and then told to adopt it (the sidebar reveal
 * path takes no task id, so the binding is posted to the webview instead).
 */
export async function openExistingSession(
	context: { extensionUri: vscode.Uri },
	provider: VscodeWebviewProvider,
	sessionId: string,
	location: NewChatLocation,
): Promise<void> {
	const existing = chatSurfaceForSession(sessionId)
	if (existing !== undefined) {
		const { handle } = await revealChatSurfaceById(context, provider, existing, location)
		if (handle) {
			return
		}
		// The surface claimed the session but could not be revealed (its webview is gone).
		// Fall through and open the session fresh rather than leaving the click dead.
	}

	if (location === "editor") {
		openChatInEditorPanel(context, provider, { taskId: sessionId })
	} else {
		const handle = await revealChatSurface(context, provider, location, sessionId)
		handle?.postMessage({ type: "bindTaskToSurface", sessionId })
	}

	// Binding only says WHICH chat the surface owns — it does not load it, which is why a click
	// used to land on an empty New Chat home. Hydrate the session so its transcript is delivered.
	// Called on the controller directly rather than through the showTaskWithId RPC wrapper: that
	// wrapper also fires a chatButtonClicked at the ACTIVE surface, which is a different chat.
	try {
		await provider.controller.showTaskWithId(sessionId)
	} catch (error) {
		Logger.error("Failed to open session from the chats list:", error)
	}
}

/**
 * Reveal the chat surface with the given routing id, wherever it lives — the sidebar or an editor
 * panel. Falls back to revealing the configured location when the id is unknown (e.g. that surface
 * has closed). The primary-bar container is NOT searched: it hosts the chats list, never a chat.
 *
 * This is what "jump to the chat" commands use: the target is the chat the user is WORKING IN,
 * which is not necessarily the configured new-chat location.
 */
export async function revealChatSurfaceById(
	context: { extensionUri: vscode.Uri },
	provider: VscodeWebviewProvider,
	surfaceId: string | undefined,
	fallbackLocation: NewChatLocation,
): Promise<{ handle: ChatSurfaceHandle | undefined; surfaceId: string | undefined }> {
	if (surfaceId) {
		if (provider.getSurfaceId() === surfaceId) {
			await vscode.commands.executeCommand(`workbench.view.extension.${ExtensionRegistryInfo.views.ActivityBarSecondary}`)
			provider.getWebview()?.show(true)
			return { handle: webviewHandle(provider.getWebview()?.webview), surfaceId }
		}
		const panels = new Set<vscode.WebviewPanel>([...taskChatPanels.values()])
		if (unboundChatPanel) {
			panels.add(unboundChatPanel)
		}
		for (const panel of panels) {
			if (panelSurfaceIds.get(panel) === surfaceId) {
				panel.reveal()
				return { handle: webviewHandle(panel.webview), surfaceId }
			}
		}
	}
	const handle = await revealChatSurfaceInner(context, provider, fallbackLocation)
	return { handle, surfaceId: getActiveChatSurface() }
}

/**
 * Open or create a chat in the target area — the ONE shared behavior behind every new-chat
 * button (Button #1, Button #2, Button #3, the "+", and the palette commands).
 *
 * - "editor" → a new editor panel on the home: a new, independent chat, every press.
 * - A sidebar showing NO chat (the home, or never opened this window) → reveal it; the home IS
 *   the new chat, ready for its first prompt.
 * - A sidebar already showing a chat → a sidebar holds ONE chat at full height, so the new,
 *   independent chat opens as an editor tab beside it and the sidebar chat is left completely
 *   alone — still bound, still streaming, still visible. (Claude Code's shipped model: a
 *   capacity-1 docked chat plus unlimited editor chats.) An occupied-but-hidden sidebar
 *   overflows the same way without being forced open.
 */
export async function openOrCreateChat(
	context: { extensionUri: vscode.Uri },
	provider: VscodeWebviewProvider,
	targetArea: NewChatLocation,
): Promise<void> {
	if (targetArea !== "editor") {
		// ONE question, asked of the window itself: is the sidebar chat on screen right now?
		//
		//   NOT on screen — never opened, its view disposed, the bar closed, or another view in
		//   front of it → REVEAL it. If it holds a chat the user gets that chat back (a hidden
		//   chat is shown, never skipped past); if it is empty they get its New Chat home, ready
		//   for a first prompt. Either way the press produces something visible.
		//
		//   ON screen — showing its home OR an active chat → the sidebar's one slot is in use, so
		//   a NEW chat opens as an editor tab beside it.
		//
		// Read live from VS Code at the moment of the press, which is why it cannot go stale.
		// Both earlier tests asked the registry to REMEMBER something instead, and memory drifts:
		// session-boundness missed the empty home (every button looked dead until something had
		// been typed into the sidebar), and surface-existence went permanently sticky, because a
		// sidebar surface registers when its view resolves and never unregisters — so after any
		// moment the sidebar had been open, the very first chat was sent to an editor tab while
		// the sidebar sat empty.
		const sidebarOnScreen = provider.getWebview()?.visible === true
		if (!sidebarOnScreen) {
			await revealChatSurface(context, provider, targetArea)
			return
		}
	}
	await revealChatSurface(context, provider, "editor")
}
