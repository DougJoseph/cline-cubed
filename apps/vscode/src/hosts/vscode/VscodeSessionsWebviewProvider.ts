import {
	onChatSurfacesChanged,
	openChatSurfaces,
	registerChatSurface,
	sessionForChatSurface,
} from "@core/controller/chat-surfaces"
import { type HtmlWebviewSource, WebviewProvider } from "@core/webview"
import { mintSurfaceId } from "@core/webview/WebviewProvider"
import * as vscode from "vscode"
import { handleGrpcRequest, handleGrpcRequestCancel } from "@/core/controller/grpc-handler"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import type { ExtensionMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { WebviewMessage } from "@/shared/WebviewMessage"
import { openExistingSession, openOrCreateChat } from "./chatEditorPanel"
import { VscodeWebviewProvider } from "./VscodeWebviewProvider"

/**
 * The CHATS LIST in the primary activity-bar container.
 *
 * The primary bar is no longer a chat location (retired 2026-08-27), so its container hosts a list
 * instead of a chat: the chats open right now and where each one lives, then the full history, and
 * a New Chat button. Clicking the activity-bar icon simply shows this list and leaves it up —
 * which is why the icon no longer flashes a panel open and shut, and why it is never a dead click.
 * Mirrors Claude Code, whose primary-bar container hosts a sessions list rather than a chat.
 *
 * It renders the same webview bundle with `viewKind: "sessions"`, and delegates to the shared
 * singleton for HTML + controller. IMPORTANT: this class must NOT extend WebviewProvider — that
 * base class's constructor creates a NEW Controller and overwrites the shared singleton.
 */
export class VscodeSessionsWebviewProvider implements vscode.WebviewViewProvider {
	/** The list view in the primary-bar container. The id is unchanged from when this view hosted
	 *  a chat: VS Code caches view state by id, so renaming it would strand existing installs. */
	public static readonly SIDEBAR_CHAT_ID = ExtensionRegistryInfo.views.SidebarChat

	private static chatInstance: VscodeSessionsWebviewProvider | undefined

	private webviewView?: vscode.WebviewView
	private disposables: vscode.Disposable[] = []
	/** Cline Cubed: this surface's routing id. Registered bound to null for its whole life — the
	 *  list is NOT a chat surface, so it never displays a conversation; the binding exists only so
	 *  the per-surface state filter withholds other chats' transcripts from it. */
	private readonly surfaceId = mintSurfaceId("chats-list")

	public getSurfaceId(): string {
		return this.surfaceId
	}

	constructor(private readonly context: vscode.ExtensionContext) {
		VscodeSessionsWebviewProvider.chatInstance = this
	}

	public static getChatInstance(): VscodeSessionsWebviewProvider | undefined {
		return VscodeSessionsWebviewProvider.chatInstance
	}

	public getWebview(): vscode.WebviewView | undefined {
		return this.webviewView
	}

	public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
		this.disposeView()
		this.webviewView = webviewView

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(HostProvider.get().extensionFsPath)],
		}

		// Resource URLs must be built against THIS webview (each has its own origin), so pass a
		// target accessor rather than the singleton's own webview.
		const mainProvider = WebviewProvider.getInstance()
		const htmlTarget: HtmlWebviewSource = {
			cspSource: webviewView.webview.cspSource,
			webviewUrlForPath: (assetPath) => webviewView.webview.asWebviewUri(vscode.Uri.file(assetPath)).toString(),
		}
		registerChatSurface(this.surfaceId, null)
		const identity = {
			surfaceId: this.surfaceId,
			sessionId: sessionForChatSurface(this.surfaceId) ?? null,
			viewKind: "sessions" as const,
		}
		webviewView.webview.html =
			this.context.extensionMode === vscode.ExtensionMode.Development
				? await mainProvider.getHMRHtmlContent(htmlTarget, identity)
				: mainProvider.getHtmlContent(htmlTarget, identity)

		this.setWebviewMessageListener(webviewView.webview)

		// Keep the list current: any bind, unbind or surface teardown changes what it shows.
		this.disposables.push({ dispose: onChatSurfacesChanged(() => this.postOpenChats()) })
		webviewView.onDidChangeVisibility(
			() => {
				if (webviewView.visible) {
					this.postOpenChats()
				}
			},
			null,
			this.disposables,
		)
		this.postOpenChats()

		webviewView.onDidDispose(
			() => {
				if (this.webviewView === webviewView) {
					this.disposeView()
				}
			},
			null,
			this.disposables,
		)
	}

	/**
	 * Tell the list which chat is open where.
	 *
	 * The location label is derived from the surface id (minted as `secondary-sidebar-N` /
	 * `editor-panel-N`), so no extra bookkeeping is needed to describe a surface. Chat TITLES are
	 * not sent: the list already receives `taskHistory` in its state and looks each one up there.
	 */
	private postOpenChats(): void {
		const openChats = openChatSurfaces()
			.filter(({ surfaceId }) => surfaceId !== this.surfaceId)
			.map(({ surfaceId, sessionId }) => ({ sessionId, location: locationLabelForSurfaceId(surfaceId) }))
		void this.postMessageToWebview({ type: "openChats", openChats })
	}

	private setWebviewMessageListener(webview: vscode.Webview) {
		webview.onDidReceiveMessage(
			(message: WebviewMessage) => {
				void this.handleWebviewMessage(message)
			},
			null,
			this.disposables,
		)
	}

	async handleWebviewMessage(message: WebviewMessage) {
		const mainProvider = WebviewProvider.getInstance()
		const postMessageToWebview = (response: ExtensionMessage) => this.postMessageToWebview(response)

		switch (message.type) {
			case "grpc_request": {
				if (message.grpc_request) {
					await handleGrpcRequest(mainProvider.controller, postMessageToWebview, message.grpc_request, this.surfaceId)
				}
				break
			}
			case "grpc_request_cancel": {
				if (message.grpc_request_cancel) {
					await handleGrpcRequestCancel(postMessageToWebview, message.grpc_request_cancel)
				}
				break
			}
			case "openSession": {
				// A row click: reveal the chat where it already lives, or open it in the
				// configured location if it is not open anywhere.
				if (typeof message.sessionId === "string") {
					const location = mainProvider.controller.stateManager.getGlobalSettingsKey("newChatLocation")
					await openExistingSession(this.context, mainProvider as VscodeWebviewProvider, message.sessionId, location)
				}
				break
			}
			case "newChatFromList": {
				const location = mainProvider.controller.stateManager.getGlobalSettingsKey("newChatLocation")
				await openOrCreateChat(this.context, mainProvider as VscodeWebviewProvider, location)
				break
			}
			case "dismissOnboarding": {
				mainProvider.controller.stateManager.setGlobalState("clineCubedShowOnboarding", false)
				await mainProvider.controller.postStateToWebview()
				break
			}
			default: {
				Logger.error("Received unhandled WebviewMessage type:", JSON.stringify(message))
			}
		}
	}

	private async postMessageToWebview(message: ExtensionMessage): Promise<boolean | undefined> {
		return this.webviewView?.webview.postMessage(message)
	}

	/**
	 * Show Marketplace / Account / Settings INSIDE this panel.
	 *
	 * The chat views' toolbar buttons fire an event at the ACTIVE CHAT surface, which is a
	 * different webview — from this panel that drove some other chat, and did nothing at all when
	 * no chat was open. The panel's own buttons call this instead, so they act where they were
	 * clicked.
	 */
	public showPanel(listPanel: "marketplace" | "account" | "settings"): void {
		void this.postMessageToWebview({ type: "showListPanel", listPanel })
	}

	private disposeView() {
		while (this.disposables.length) {
			const x = this.disposables.pop()
			if (x) {
				x.dispose()
			}
		}
		this.webviewView = undefined
	}
}

/** Human location for a surface, read from the id minted when the surface was created. */
function locationLabelForSurfaceId(surfaceId: string): string {
	if (surfaceId.startsWith("secondary-sidebar")) {
		return "Sidebar"
	}
	if (surfaceId.startsWith("editor-panel")) {
		return "Editor tab"
	}
	return "Open"
}
