import {
	bindChatSurfaceToSession,
	chatSurfaceForSession,
	getActiveChatSurface,
	onChatTitleChanged,
	registerChatSurface,
	sessionForChatSurface,
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

export const CHAT_PANEL_VIEW_TYPE = "cline-cubed-ChatPanel"

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
		// Cline Cubed: a FRESH panel boots already bound — its session is in the HTML. A REUSED
		// panel does not: it booted as the empty New Chat home and nothing above tells its webview
		// otherwise, so binding alone left the click showing the home instead of the chat. Tell the
		// webview which chat it now holds; it binds and navigates on this message.
		void panel.webview.postMessage({ type: "bindTaskToSurface", sessionId: taskId })
	} else {
		unboundChatPanel = panel
	}
	return panel
}

/**
 * Everything that makes a WebviewPanel a live chat surface: the surface id, registry entry,
 * eviction notifier, HTML (with the binding baked in), the gRPC/message listener, the title
 * listener, the honest-close dispose handler, and the focus re-assert. ONE implementation,
 * shared by createChatPanel (fresh opens) and adoptRevivedChatPanel (panels VS Code revives
 * after a window reload) — duplicated wiring is how surfaces drift.
 */
function wireChatPanel(
	context: { extensionUri: vscode.Uri },
	provider: VscodeWebviewProvider,
	panel: vscode.WebviewPanel,
	taskId?: string,
): string {
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
			case "openSessionHere": {
				if (typeof message.sessionId === "string") {
					const { openedHere } = await openSessionInRequestingSurface(
						context,
						provider,
						surfaceId,
						webviewHandle(panel.webview),
						message.sessionId,
					)
					if (openedHere) {
						// The tab's own bookkeeping and label, exactly as a bindSurfaceSession would set.
						bindChatPanelToTask(panel, provider, message.sessionId)
					}
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
		// Cline Cubed: closing the tab is the user closing this chat — record the ending at the
		// moment it happens, instead of leaving the session to linger unended until a teardown
		// sweep invents a time for it. Captured BEFORE unregistering, then checked AFTER: if any
		// other surface still claims the session, the chat was MOVED (bind transfer), not closed,
		// and its new surface owns it.
		const closingSessionId = sessionForChatSurface(surfaceId)
		unregisterChatSurface(surfaceId)
		for (const [boundTaskId, p] of taskChatPanels) {
			if (p === panel) {
				taskChatPanels.delete(boundTaskId)
			}
		}
		if (unboundChatPanel === panel) {
			unboundChatPanel = undefined
		}
		if (typeof closingSessionId === "string" && chatSurfaceForSession(closingSessionId) === undefined) {
			provider.controller.closeSession(closingSessionId).catch((error) => {
				Logger.error(`Failed to end session ${closingSessionId} on tab close:`, error)
			})
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
	return surfaceId
}

/**
 * Cline Cubed: restore hydrations run ONE AT A TIME, chained. `showTaskWithId` carries a
 * generation fence — every newer call makes older in-flight ones abandon themselves — so the
 * near-simultaneous hydrations of a reload (the sidebar at activation, then each revived
 * panel) killed each other: only the LAST completed and every other surface booted bound but
 * transcript-less, which renders as a Home (Doug's reload test: of three chats, only one came
 * back, deterministically). Serializing them lets each finish before the next starts, so the
 * fence never sees a competitor.
 */
let reviveHydrationChain: Promise<void> = Promise.resolve()
export function enqueueReviveHydration(sessionId: string, hydrate: () => Promise<unknown>): void {
	reviveHydrationChain = reviveHydrationChain.then(async () => {
		try {
			await hydrate()
		} catch (error) {
			Logger.error(`Failed to hydrate restored session ${sessionId}:`, error)
		}
	})
}

/**
 * Cline Cubed: adopt a chat panel VS Code revived after a window reload (via the
 * WebviewPanelSerializer registered in extension.ts). The panel exists but has none of its
 * wiring; give it the full treatment, rebind it to the session the webview recorded before
 * the reload, and hydrate the transcript. A revive with no recorded session boots as a home.
 * Restored sessions are not live — the reload killed the extension host, and the
 * stale-session reconciler has stamped their honest end times — so the panel shows the
 * transcript, ready to resume through the normal path.
 */
export async function adoptRevivedChatPanel(
	context: { extensionUri: vscode.Uri },
	provider: VscodeWebviewProvider,
	panel: vscode.WebviewPanel,
	sessionId: string | undefined,
): Promise<void> {
	// The icon does not survive the reload; set it again.
	const iconUri = vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "icon.svg")
	const iconDarkUri = vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "icon-dark.svg")
	panel.iconPath = { light: iconUri, dark: iconDarkUri }
	wireChatPanel(context, provider, panel, sessionId)
	if (sessionId) {
		bindChatPanelToTask(panel, provider, sessionId)
		enqueueReviveHydration(sessionId, () => provider.controller.showTaskWithId(sessionId))
	}
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

	wireChatPanel(context, provider, panel, taskId)

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
 * Is this tab one of our chat panels?
 *
 * The view type VS Code reports on a TAB is NOT the one the panel was created with: every
 * extension webview panel is opened through a transformer that prefixes it, so a tab created
 * as `cline-cubed-ChatPanel` reads back as `mainThreadWebview-cline-cubed-ChatPanel`. An
 * equality test against the raw view type therefore never matches — which is why the
 * chat-only-group reuse below silently never fired, and every chat took a fresh column and
 * locked it (Doug: "multiple locked groups with ONE chat each — not as good", 2026-08-30).
 * Claude's own extension writes this same check as a substring test for the same reason.
 * Suffix-matching keeps it correct whether or not the host applies the prefix.
 */
export function isChatPanelTab(tab: vscode.Tab): boolean {
	return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(CHAT_PANEL_VIEW_TYPE)
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
		return group.tabs.every(isChatPanelTab)
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
		// Cline Cubed: the sidebar holds ONE chat. If it is already showing a different live
		// chat, the selected chat overflows to its own editor tab — same rule as the New Chat
		// buttons — instead of rebinding the sidebar and destroying the view of the chat it held.
		const sidebarSurfaceId = provider.getSurfaceId()
		const sidebarOccupant = sessionForChatSurface(sidebarSurfaceId)
		if (typeof sidebarOccupant === "string" && sidebarOccupant !== sessionId) {
			openChatInEditorPanel(context, provider, { taskId: sessionId })
		} else {
			// Bind BEFORE revealing. A CLOSED sidebar has no webview yet — VS Code resolves it
			// asynchronously after the reveal command — so a message posted now reaches nobody
			// and the fresh sidebar boots as an unbound home. The provider bakes the surface's
			// current binding into the webview's HTML at resolve, so binding first makes a cold
			// sidebar boot already holding the chat. A still-open sidebar gets the message as
			// before; if the webview is mid-resolve, wait briefly for it.
			bindChatSurfaceToSession(sidebarSurfaceId, sessionId)
			const handle = await revealChatSurface(context, provider, location, sessionId)
			if (handle) {
				handle.postMessage({ type: "bindTaskToSurface", sessionId })
			} else {
				for (let waited = 0; waited < 3000 && !provider.getWebview(); waited += 150) {
					await new Promise((resolve) => setTimeout(resolve, 150))
				}
				const lateWebview = provider.getWebview()?.webview
				if (lateWebview) {
					webviewHandle(lateWebview)?.postMessage({ type: "bindTaskToSurface", sessionId })
				} else {
					// The reveal failed and the sidebar's webview never appeared. Leaving the
					// pre-reveal binding standing would be a STALE claim: the registry says the
					// sidebar holds this chat while the sidebar shows nothing — so closing the
					// sidebar later would end a chat it never displayed, and the chat could not
					// open anywhere else (the registry says it is already open). Release the
					// claim and open the chat as an editor tab instead, so the click still
					// opens it — the same overflow rule every other dead-end here follows.
					Logger.warn(`Sidebar reveal failed for session ${sessionId}; releasing the binding and opening an editor tab`)
					bindChatSurfaceToSession(sidebarSurfaceId, null)
					openChatInEditorPanel(context, provider, { taskId: sessionId })
				}
			}
		}
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
 * Open an existing chat from a CHAT surface's own history/recent list.
 *
 * The rule (Doug, 2026-08-29): accidentally reopening a chat that is already open must never
 * move it. If another surface shows this session, that surface is revealed, a small notice says
 * so, and the asking surface is left exactly as it was. Only a session open NOWHERE opens in the
 * asking surface — the host binds it (this channel knows the sender, unlike a unary RPC) and
 * answers with "bindTaskToSurface" so the webview adopts the session and navigates itself.
 */
export async function openSessionInRequestingSurface(
	context: { extensionUri: vscode.Uri },
	provider: VscodeWebviewProvider,
	requestingSurfaceId: string,
	requesterHandle: ChatSurfaceHandle | undefined,
	sessionId: string,
): Promise<{ openedHere: boolean }> {
	const existing = chatSurfaceForSession(sessionId)
	if (existing !== undefined && existing !== requestingSurfaceId) {
		const location = provider.controller.stateManager.getGlobalSettingsKey("newChatLocation")
		const revealed = await revealChatSurfaceById(context, provider, existing, location)
		// Only a reveal of the surface that actually holds the chat counts. The fallback inside
		// revealChatSurfaceById reveals the CONFIGURED location when the id is gone — that is a
		// different surface, and treating it as success would toast over a dead click.
		if (revealed.surfaceId === existing && revealed.handle) {
			vscode.window.showInformationMessage("This chat is already open — brought it into view.")
			return { openedHere: false }
		}
		// The claiming surface's webview is gone; fall through and open here instead.
	}

	// Cline Cubed: never steal a live chat's window. The clicking surface fills in place ONLY
	// when it is empty (a home) — nothing is lost there, and a new tab would strand a dead home.
	// A surface already showing a chat keeps it: the selected chat opens in its OWN editor tab,
	// so three history clicks give three windows, not one window rebound three times.
	const occupant = sessionForChatSurface(requestingSurfaceId)
	if (typeof occupant === "string" && occupant !== sessionId) {
		openChatInEditorPanel(context, provider, { taskId: sessionId })
		try {
			await provider.controller.showTaskWithId(sessionId)
		} catch (error) {
			Logger.error("Failed to open a session in a new editor tab from a history list:", error)
		}
		return { openedHere: false }
	}

	bindChatSurfaceToSession(requestingSurfaceId, sessionId)
	requesterHandle?.postMessage({ type: "bindTaskToSurface", sessionId })
	// Binding only says WHICH chat the surface owns — hydrate so the transcript is delivered.
	try {
		await provider.controller.showTaskWithId(sessionId)
	} catch (error) {
		Logger.error("Failed to open a session from a chat surface's history list:", error)
	}
	return { openedHere: true }
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
