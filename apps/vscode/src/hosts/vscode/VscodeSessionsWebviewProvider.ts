import { type HtmlWebviewSource, type WebviewKind, WebviewProvider } from "@core/webview"
import * as vscode from "vscode"
import { handleGrpcRequest, handleGrpcRequestCancel } from "@/core/controller/grpc-handler"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import type { ExtensionMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { WebviewMessage } from "@/shared/WebviewMessage"
import { revealChatSurface } from "./chatEditorPanel"
import { VscodeWebviewProvider } from "./VscodeWebviewProvider"

/**
 * Delegating webview provider for Button #1's panel (the primary-bar Sessions container):
 * kind="chat" → `cline-cubed.SidebarChatProvider`, the chat webview — the "What can I do for
 * you?" home (history preview + prompt input) when no chat is open, and the current chat in the
 * same panel when one is. Button #1's open/create-in-Settings-location behavior runs when this
 * view becomes visible (V5): no current chat → the home shows in the Settings location; current
 * chat exists → a fresh, independent chat there.
 *
 * It delegates to the shared singleton for HTML + controller. IMPORTANT: this class must NOT
 * extend WebviewProvider — that base class's constructor creates a NEW Controller and
 * overwrites the shared singleton (WebviewProvider.instance). Each surface gets its OWN
 * instance so multiple chat surfaces can coexist without the single-provider collision bug.
 */
export class VscodeSessionsWebviewProvider implements vscode.WebviewViewProvider {
	/** Button #1's chat view in the primary-bar Sessions container (kind=chat). */
	public static readonly SIDEBAR_CHAT_ID = ExtensionRegistryInfo.views.SidebarChat

	/** The kind="chat" instance, so chat-surface reveal can focus it. */
	private static chatInstance: VscodeSessionsWebviewProvider | undefined

	private webviewView?: vscode.WebviewView
	private disposables: vscode.Disposable[] = []
	/** When this provider was created (ms epoch) — the startup window during which a
	 *  window-restore/activation auto-reveal must NOT trigger Button #1's open/create. */
	private createdTs = Date.now()

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly kind: WebviewKind = "chat",
	) {
		if (kind === "chat") {
			VscodeSessionsWebviewProvider.chatInstance = this
		}
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
			// Allow scripts in the webview
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(HostProvider.get().extensionFsPath)],
		}

		// Same HTML as the chat webview (kind=chat → the full chat: "What can I do for you?"
		// home + prompt input + history preview). Resource URLs must be built against THIS
		// webview (each webview has its own origin), so pass a target accessor.
		const mainProvider = WebviewProvider.getInstance()
		const htmlTarget: HtmlWebviewSource = {
			cspSource: webviewView.webview.cspSource,
			webviewUrlForPath: (assetPath) => webviewView.webview.asWebviewUri(vscode.Uri.file(assetPath)).toString(),
		}
		webviewView.webview.html =
			this.context.extensionMode === vscode.ExtensionMode.Development
				? await mainProvider.getHMRHtmlContent(this.kind, htmlTarget)
				: mainProvider.getHtmlContent(this.kind, htmlTarget)

		this.setWebviewMessageListener(webviewView.webview)

		// Release view-scoped resources on dispose. The shared controller stays alive.
		webviewView.onDidDispose(
			() => {
				if (this.webviewView === webviewView) {
					this.disposeView()
				}
			},
			null,
			this.disposables,
		)

		// Button #1 (V5.1): the primary-bar icon reveals this view. ANY reveal — the first
		// resolution or a hidden→visible transition — triggers the open/create-in-Settings-location
		// behavior: no current chat → the "What can I do for you?" home shows there; current chat
		// exists → a fresh, independent chat. The ONLY skip is a window-restore/activation-time
		// auto-reveal (within a few seconds of provider creation), so the Settings-location
		// surface never pops open on its own at startup.
		const maybeRunButton1 = () => {
			if (this.kind !== "chat" || !webviewView.visible) {
				return
			}
			if (Date.now() - this.createdTs < 3000) {
				return
			}
			void this.handlePrimaryButtonPressed()
		}
		webviewView.onDidChangeVisibility(maybeRunButton1, null, this.disposables)
		// The first resolution (the user's first click of the icon) has no visibility-CHANGE
		// event — run it once now that the view is first shown.
		maybeRunButton1()
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
					await handleGrpcRequest(mainProvider.controller, postMessageToWebview, message.grpc_request)
				}
				break
			}
			case "grpc_request_cancel": {
				if (message.grpc_request_cancel) {
					await handleGrpcRequestCancel(postMessageToWebview, message.grpc_request_cancel)
				}
				break
			}
			case "selectTask": {
				// V5: the sessions chooser is retired; nothing sends this anymore. If a stale
				// webview ever does, fall through to the default logger rather than acting.
				break
			}
			case "syncChatLocation": {
				// The left chat webview's Settings dropdown posts this (same as the main
				// provider's handler): reveal the new surface immediately (no blank panel).
				await revealChatSurface(
					this.context,
					mainProvider as VscodeWebviewProvider,
					message.newChatLocation ?? "secondarySidebar",
				)
				break
			}
			case "dismissOnboarding": {
				// Leave the "Cline Cubed: Get Started" re-view without flipping welcomeViewCompleted.
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

	/** Button #1 (V5): open/create a chat in the Settings location. */
	private async handlePrimaryButtonPressed(): Promise<void> {
		const mainProvider = WebviewProvider.getInstance()
		const location = mainProvider.controller.stateManager.getGlobalSettingsKey("newChatLocation")
		const hasCurrentChat = !!mainProvider.controller.task
		const surface = await revealChatSurface(this.context, mainProvider as VscodeWebviewProvider, location)
		if (hasCurrentChat) {
			surface?.postMessage({ type: "showNewChatHome" })
		}
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
