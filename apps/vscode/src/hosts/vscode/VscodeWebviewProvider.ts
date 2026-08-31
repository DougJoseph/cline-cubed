import {
	bindChatSurfaceToSession,
	registerChatSurface,
	sessionForChatSurface,
	setActiveChatSurface,
	setChatSurfaceEvictionNotifier,
} from "@core/controller/chat-surfaces"
import { sendShowWebviewEvent } from "@core/controller/ui/subscribeToShowWebview"
import { WebviewProvider } from "@core/webview"
import { mintSurfaceId } from "@core/webview/WebviewProvider"
import * as vscode from "vscode"
import { handleGrpcRequest, handleGrpcRequestCancel } from "@/core/controller/grpc-handler"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import { telemetryService } from "@/services/telemetry"
import type { ExtensionMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { WebviewMessage } from "@/shared/WebviewMessage"
import { openSessionInRequestingSurface } from "./chatEditorPanel"

/*
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts
https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
*/

export class VscodeWebviewProvider extends WebviewProvider implements vscode.WebviewViewProvider {
	// Used in package.json as the view's id. This value cannot be changed due to how vscode caches
	// views based on their id, and updating the id would break existing instances of the extension.
	public static readonly SIDEBAR_SECONDARY_ID = ExtensionRegistryInfo.views.SidebarSecondary

	private webview?: vscode.WebviewView
	private disposables: vscode.Disposable[] = []
	/** Cline Cubed: this surface's routing id — state and transcript are addressed to it. */
	private readonly surfaceId = mintSurfaceId("secondary-sidebar")

	/** Cline Cubed: the routing id of this chat surface. */
	public getSurfaceId(): string {
		return this.surfaceId
	}

	override getWebviewUrl(path: string) {
		if (!this.webview) {
			throw new Error("Webview not initialized")
		}
		const uri = this.webview.webview.asWebviewUri(vscode.Uri.file(path))
		return uri.toString()
	}

	override getCspSource() {
		if (!this.webview) {
			throw new Error("Webview not initialized")
		}
		return this.webview.webview.cspSource
	}

	override isVisible() {
		return this.webview?.visible || false
	}

	public getWebview(): vscode.WebviewView | undefined {
		return this.webview
	}

	/**
	 * Initializes and sets up the webview when it's first created.
	 *
	 * @param webviewView - The sidebar webview view instance to be resolved
	 * @returns A promise that resolves when the webview has been fully initialized
	 */
	public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
		// A newer view supersedes any previous one (VS Code re-resolves this same
		// provider when the view is moved between sidebars). Release the previous
		// view's listeners up front in case its onDidDispose fired late or not at all.
		this.disposeView()
		this.webview = webviewView

		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(HostProvider.get().extensionFsPath)],
		}

		// Cline Cubed: the surface is registered and given its identity in the HTML before the
		// bundle loads, so it is addressable from its first render.
		registerChatSurface(this.surfaceId, sessionForChatSurface(this.surfaceId) ?? null)
		// If this surface's session is ever reopened elsewhere (evicted), tell THIS webview to
		// step back to the home rather than freeze on a stale copy of the moved chat.
		setChatSurfaceEvictionNotifier(this.surfaceId, () => {
			void this.postMessageToWebview({ type: "showNewChatHome" })
		})
		if (webviewView.visible) {
			// This chat is in front of the user from the moment it resolves — claim the active
			// slot now, not only on the next visibility CHANGE.
			setActiveChatSurface(this.surfaceId)
		}
		const identity = { surfaceId: this.surfaceId, sessionId: sessionForChatSurface(this.surfaceId) ?? null }
		webviewView.webview.html =
			this.context.extensionMode === vscode.ExtensionMode.Development
				? await this.getHMRHtmlContent(undefined, identity)
				: this.getHtmlContent(undefined, identity)

		// Sets up an event listener to listen for messages passed from the webview view context
		// and executes code based on the message that is received
		this.setWebviewMessageListener(webviewView.webview)
		telemetryService.capturePanelOpened("sidebar_resolved")

		// Logs show up in bottom panel > Debug Console
		//Logger.log("registering listener")

		// Listen for when the sidebar becomes visible
		// https://github.com/microsoft/vscode-discussions/discussions/840

		// onDidChangeVisibility is only available on the sidebar webview
		// Otherwise WebviewView and WebviewPanel have all the same properties except for this visibility listener
		// WebviewPanel is not currently used in the extension
		webviewView.onDidChangeVisibility(
			async () => {
				if (this.webview?.visible) {
					// Cline Cubed: this chat is now the one the user is working in, so
					// command-palette actions and toolbar buttons aim here.
					setActiveChatSurface(this.surfaceId)
					telemetryService.capturePanelOpened("sidebar_visible")
					// View becoming visible should not steal editor focus.
					await sendShowWebviewEvent(true, this.surfaceId)
					return
				}
				// Cline Cubed: closing the sidebar closes the chat it holds. VS Code reports that
				// through whichever event it happens to deliver — this one, or onDidDispose — so
				// BOTH end the chat, and endSidebarChat runs once for a given close. The single
				// exception is a view that comes straight back because the user dragged it to the
				// other sidebar: that is a move, and endSidebarChat's re-check catches it.
				this.endSidebarChat("sidebar view no longer showing")
			},
			null,
			this.disposables,
		)

		// Listen for when the view is disposed. This happens when the user moves the
		// view between the primary and secondary sidebars: VS Code destroys the old
		// WebviewView and calls resolveWebviewView again on this same provider with a
		// new one. Only release view-scoped resources here — the controller must stay
		// alive so the re-resolved view keeps working. The controller is disposed on
		// extension deactivation (tearDown -> WebviewProvider.disposeAllInstances).
		webviewView.onDidDispose(
			() => {
				// resolveWebviewView awaits HTML generation, so an old view's dispose
				// event can arrive after a newer view has already been resolved. Only
				// tear down if this view is still the active one.
				if (this.webview === webviewView) {
					this.disposeView()
					// Cline Cubed: see the visibility handler above — closing the sidebar ends the
					// chat it holds, whichever event VS Code delivers for it.
					this.endSidebarChat("sidebar view disposed")
				}
			},
			null,
			this.disposables,
		)

		// Cline Cubed: stock cleared "stale task state" here on the view's first resolve —
		// written for a world where the view resolving meant the extension was just
		// starting and nothing could be running. Here the sidebar view first resolves
		// whenever the user first opens that sidebar, which can be mid-session with
		// chats running in editor tabs — and clearTask() ends the ACTIVE session, so
		// that clear silently killed a running chat (whose next message then started a
		// new session: a silent fork). A resolving view boots from its own surface
		// binding — Home when unbound — so there is no shared stale state to clear,
		// and nothing to do here.

		Logger.log("[VscodeWebviewProvider] Webview view resolved")

		// Title setting logic removed to allow VSCode to use the container title primarily.
	}

	/**
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is received.
	 *
	 * IMPORTANT: When passing methods as callbacks in JavaScript/TypeScript, the method's
	 * 'this' context can be lost. This happens because the method is passed as a
	 * standalone function reference, detached from its original object.
	 *
	 * The Problem:
	 * Doing: webview.onDidReceiveMessage(this.controller.handleWebviewMessage)
	 * Would cause 'this' inside handleWebviewMessage to be undefined or wrong,
	 * leading to "TypeError: this.setUserInfo is not a function"
	 *
	 * The Solution:
	 * We wrap the method call in an arrow function, which:
	 * 1. Preserves the lexical scope's 'this' binding
	 * 2. Ensures handleWebviewMessage is called as a method on the controller instance
	 * 3. Maintains access to all controller methods and properties
	 *
	 * Alternative solutions could use .bind() or making handleWebviewMessage an arrow
	 * function property, but this approach is clean and explicit.
	 *
	 * @param webview The webview instance to attach the message listener to
	 */
	private setWebviewMessageListener(webview: vscode.Webview) {
		webview.onDidReceiveMessage(
			(message) => {
				this.handleWebviewMessage(message)
			},
			null,
			this.disposables,
		)
	}

	/**
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is received.
	 *
	 * @param webview A reference to the extension webview
	 */
	async handleWebviewMessage(message: WebviewMessage) {
		const postMessageToWebview = (response: ExtensionMessage) => this.postMessageToWebview(response)

		switch (message.type) {
			case "grpc_request": {
				if (message.grpc_request) {
					await handleGrpcRequest(this.controller, postMessageToWebview, message.grpc_request, this.surfaceId)
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
					const webview = this.getWebview()?.webview
					await openSessionInRequestingSurface(
						{ extensionUri: this.context.extensionUri },
						this,
						this.surfaceId,
						webview ? { postMessage: (m) => void webview.postMessage(m) } : undefined,
						message.sessionId,
					)
				}
				break
			}
			case "bindSurfaceSession": {
				// Cline Cubed: this surface now shows that session — deliver its state and
				// transcript here, and release any other surface that was claiming it.
				bindChatSurfaceToSession(this.surfaceId, message.sessionId ?? null)
				if (typeof message.sessionId === "string") {
					// A surface binding AFTER a session's opening state post would miss that
					// snapshot — repost that session's state so the first render cannot be skipped.
					await this.controller.postStateToWebview(message.sessionId)
				}
				break
			}
			case "dismissOnboarding": {
				// The user left the "Cline Cubed: Get Started" re-view — clear the flag WITHOUT
				// touching welcomeViewCompleted (we never pretend to be a new user).
				this.controller.stateManager.setGlobalState("clineCubedShowOnboarding", false)
				await this.controller.postStateToWebview()
				break
			}
			default: {
				Logger.error("Received unhandled WebviewMessage type:", JSON.stringify(message))
			}
		}
	}

	/**
	 * Sends a message from the extension to the webview.
	 *
	 * @param message - The message to send to the webview
	 * @returns A thenable that resolves to a boolean indicating success, or undefined if the webview is not available
	 */
	private async postMessageToWebview(message: ExtensionMessage): Promise<boolean | undefined> {
		return this.webview?.webview.postMessage(message)
	}

	/** Cline Cubed: targeted host→webview message for THIS surface. Other chat surfaces never
	 *  receive it. */
	public sendMessageToWebview(message: ExtensionMessage): void {
		void this.webview?.webview.postMessage(message)
	}

	/**
	 * Releases resources tied to the current WebviewView without tearing down the
	 * controller, so this provider can be re-resolved with a new WebviewView (e.g.
	 * when the user moves the view to the other sidebar).
	 */
	/**
	 * Cline Cubed: the sidebar's chat ends when its view goes away — Doug's rule, stated plainly:
	 * closing the sidebar, closing a tab, or clicking the X ends the chat.
	 *
	 * VS Code does not offer a "the user closed this view" event; it reports a view going away
	 * through onDidChangeVisibility or onDidDispose depending on the gesture, so both call here
	 * and this runs at most once per close (the binding is released before the end is recorded,
	 * so a second call finds nothing to end).
	 *
	 * The ONE case that is not a close: the user drags the view to the other sidebar, which
	 * destroys and immediately re-resolves it. That is a move and the chat must survive it — so
	 * the end is confirmed on the next tick, by which time a move has already re-resolved the
	 * view (`this.webview` set again) or rebound the surface elsewhere.
	 */
	private endSidebarChat(reason: string): void {
		const closingSessionId = sessionForChatSurface(this.surfaceId)
		if (typeof closingSessionId !== "string") {
			return
		}
		// The binding is deliberately NOT touched yet. A drag to the other sidebar destroys and
		// re-resolves the view, and the re-resolve rehydrates the chat FROM this binding — an
		// earlier version released it immediately and judged the move on the next tick, which
		// both ended the moved chat and guaranteed the rebuilt view booted as the home. Wait a
		// real interval instead: a move has re-resolved by then and nothing was disturbed; a
		// close has not, and the chat ends there.
		setTimeout(() => {
			if (this.webview?.visible) {
				return // the view came back — a move between sidebars, not a close
			}
			if (sessionForChatSurface(this.surfaceId) !== closingSessionId) {
				return // rebound meanwhile — not ours to end
			}
			bindChatSurfaceToSession(this.surfaceId, null)
			this.controller.closeSession(closingSessionId).catch((error) => {
				Logger.error(`Failed to end session ${closingSessionId} (${reason}):`, error)
			})
		}, 1500)
	}

	private disposeView() {
		// WebviewView doesn't have a dispose method, it's managed by VSCode
		// We just need to clean up our disposables
		while (this.disposables.length) {
			const x = this.disposables.pop()
			if (x) {
				x.dispose()
			}
		}
		this.webview = undefined
	}

	override async dispose() {
		this.disposeView()
		await super.dispose()
	}
}
