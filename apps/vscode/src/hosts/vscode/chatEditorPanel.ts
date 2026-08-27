import { NewChatLocation } from "@shared/storage/types"
import * as vscode from "vscode"
import { handleGrpcRequest, handleGrpcRequestCancel } from "@/core/controller/grpc-handler"
import { showTaskWithId } from "@/core/controller/task/showTaskWithId"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import type { ExtensionMessage } from "@/shared/ExtensionMessage"
import { StringRequest } from "@/shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import { WebviewMessage } from "@/shared/WebviewMessage"
import { VscodeSessionsWebviewProvider } from "./VscodeSessionsWebviewProvider"
import { VscodeWebviewProvider } from "./VscodeWebviewProvider"

const CHAT_PANEL_VIEW_TYPE = "cline-cubed-ChatPanel"

/** Handle for posting a targeted host→webview message to ONE chat surface. The three new-chat
 *  entry points and the sessions chooser use this so only the TARGET surface is told to show
 *  the New Chat home / bind to a task — the other open chats stay untouched (V4.2). */
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
		panel = createChatPanel(context, provider, column, taskId === undefined)
	}

	if (taskId) {
		panelTaskIds.set(panel, taskId)
		taskChatPanels.set(taskId, panel)
	} else {
		unboundChatPanel = panel
	}
	return panel
}

function createChatPanel(
	context: { extensionUri: vscode.Uri },
	provider: VscodeWebviewProvider,
	column?: vscode.ViewColumn,
	newChat = false,
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
	const iconUri = vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "icon.svg")
	const iconDarkUri = vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "icon-dark.svg")
	panel.iconPath = { light: iconUri, dark: iconDarkUri }

	// Resource URLs must be built against THIS panel's webview (each webview has its own
	// origin), so pass a target accessor — not the provider's own webview.
	// A NEW chat panel (no task yet) boots into New Chat home mode via the HTML flag, so it
	// never adopts the current task even if the showNewChatHome postMessage loses the mount race.
	panel.webview.html = provider.getHtmlContent(
		"chat",
		{
			cspSource: panel.webview.cspSource,
			webviewUrlForPath: (assetPath) => panel.webview.asWebviewUri(vscode.Uri.file(assetPath)).toString(),
		},
		newChat,
	)

	const postMessageToWebview = (response: ExtensionMessage) => panel.webview.postMessage(response)
	const messageListener = panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
		switch (message.type) {
			case "grpc_request": {
				if (message.grpc_request) {
					await handleGrpcRequest(provider.controller, postMessageToWebview, message.grpc_request)
				}
				break
			}
			case "grpc_request_cancel": {
				if (message.grpc_request_cancel) {
					await handleGrpcRequestCancel(postMessageToWebview, message.grpc_request_cancel)
				}
				break
			}
			case "syncChatLocation": {
				// The editor panel's Settings dropdown posts this. The chat surface must move for
				// EVERY location change (this case was missing, so Editor → Primary/Secondary
				// never moved). revealChatSurface's closeChatSurfaceIfVisible closes this panel
				// when the chat is moving OUT of the editor.
				await revealChatSurface(context, provider, message.newChatLocation ?? "secondarySidebar")
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
	panel.onDidDispose(() => {
		messageListener.dispose()
		for (const [boundTaskId, p] of taskChatPanels) {
			if (p === panel) {
				taskChatPanels.delete(boundTaskId)
			}
		}
		if (unboundChatPanel === panel) {
			unboundChatPanel = undefined
		}
	})

	// Multi-chat editor panel: each tab is bound to its session; activating a tab resumes that
	// session in the shared controller, so switching tabs never shows another tab's chat.
	panel.onDidChangeViewState(({ webviewPanel }) => {
		if (!webviewPanel.active) {
			return
		}
		const boundTaskId = panelTaskIds.get(webviewPanel)
		if (boundTaskId) {
			void showTaskWithId(provider.controller, StringRequest.create({ value: boundTaskId })).catch((error) => {
				Logger.error("Failed to resume task on editor panel focus:", error)
			})
		}
	})

	// Mirror Claude's `editor.open`: a brand-new column gets locked so opening files can't
	// overwrite the chat tab.
	if (startedInNewColumn) {
		void vscode.commands.executeCommand("workbench.action.lockEditorGroup")
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
 * Disposes every open editor chat panel (the per-task panels and the unbound "new chat" panel).
 * Their onDidDispose handlers remove them from the maps.
 */
function closeAllChatPanels(): void {
	const panels = new Set<vscode.WebviewPanel>([...taskChatPanels.values()])
	if (unboundChatPanel) {
		panels.add(unboundChatPanel)
	}
	for (const panel of panels) {
		panel.dispose()
	}
}

/**
 * ONE visible chat surface at a time (Doug 2026-08-26): before a chat opens in a new location,
 * any surface currently showing the chat closes — the secondary sidebar (only if OUR chat view is
 * the visible one there), the primary sidebar (only if the left Chat view is visible — never
 * Explorer/source control), and any editor chat panels (unless the chat is moving INTO the
 * editor). Must be called BEFORE the `chatInPrimarySidebar` context swap, because once the left
 * Chat view's `when` flips false it is no longer "visible" and the check would miss it.
 */
export async function closeChatSurfaceIfVisible(
	targetLocation: NewChatLocation,
	secondaryChatProvider: VscodeWebviewProvider,
): Promise<void> {
	if (targetLocation !== "secondarySidebar" && secondaryChatProvider.getWebview()?.visible) {
		await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar")
	}
	if (targetLocation !== "primarySidebar") {
		const leftChatVisible = VscodeSessionsWebviewProvider.getChatInstance()?.getWebview()?.visible ?? false
		if (leftChatVisible) {
			await vscode.commands.executeCommand("workbench.action.closeSidebar")
		}
	}
	if (targetLocation !== "editor") {
		closeAllChatPanels()
	}
}

/**
 * Reveals (and focuses) the chat surface for the given `newChatLocation` setting:
 * - "primarySidebar" → the left activity-bar chat container (stock-Cline classic)
 * - "secondarySidebar" → the right secondary-sidebar chat container (Claude Code layout)
 * - "editor" → the editor-area chat panel tab
 */
export async function revealChatSurface(
	context: { extensionUri: vscode.Uri },
	provider: VscodeWebviewProvider,
	location: NewChatLocation,
	taskId?: string,
): Promise<ChatSurfaceHandle | undefined> {
	// Close any surface currently showing the chat before it moves — see closeChatSurfaceIfVisible.
	await closeChatSurfaceIfVisible(location, provider)

	// Cline Cubed (V5): the history-only sessions chooser is retired. The single remaining
	// context flags whether the primary-bar chat surface is the settings location's home.
	await vscode.commands.executeCommand("setContext", "cline-cubed:chatInPrimarySidebar", location === "primarySidebar")

	switch (location) {
		case "primarySidebar": {
			// Reveal the sessions container (Button 1) and focus the left Chat view so it
			// REPLACES the sessions chooser (don't leave both visible).
			await vscode.commands.executeCommand(`workbench.view.extension.${ExtensionRegistryInfo.views.SessionsContainer}`)
			await vscode.commands.executeCommand(`${ExtensionRegistryInfo.views.SidebarChat}.focus`)
			VscodeSessionsWebviewProvider.getChatInstance()?.getWebview()?.show(true)
			return webviewHandle(VscodeSessionsWebviewProvider.getChatInstance()?.getWebview()?.webview)
		}
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
