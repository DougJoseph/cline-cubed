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
import { recordLifecycleEvent } from "@hosts/vscode/lifecycle-table"
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
	 * Cline Cubed: the chat that ended when this provider's view went away, kept only until the
	 * next view arrives. A new view means the departure was a drag between sidebars, and that
	 * chat is reopened into it; a close is never followed by one, so nothing is revived.
	 */
	private endedChatForRevival: string | undefined

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

		// Cline Cubed: a new view on this provider means the previous one was DRAGGED to the other
		// sidebar — a close never produces one. The chat that ended on its way out is rebound to
		// this surface HERE, before the surface is registered and before the identity below is
		// read, so the replacement view is built already showing that chat — not built as the
		// home with a restore fired at it too late to be seen. Close means close; a move means
		// the chat moves.
		const revivedSessionId = this.rebindDraggedChat()

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
		if (revivedSessionId !== undefined) {
			// The binding above says WHICH chat this surface owns; the transcript is delivered by
			// the hydration, which needs the webview to exist to receive it — so it runs here,
			// after the HTML is set and the listener is attached, never before.
			try {
				await this.controller.showTaskWithId(revivedSessionId)
			} catch (error) {
				Logger.error(`Failed to revive dragged chat ${revivedSessionId}:`, error)
			}
		}
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
				recordLifecycleEvent("sidebar.visibilityChanged", {
					surfaceId: this.surfaceId,
					visible: this.webview?.visible === true,
					binding: sessionForChatSurface(this.surfaceId) ?? null,
				})
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
				// BOTH end the chat, and endSidebarChat runs once for a given close. A drag to the
				// other sidebar comes through here too and cannot be told apart yet; it is undone
				// by rebindDraggedChat when the replacement view arrives.
				this.endSidebarChat("sidebar view no longer showing", webviewView)
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
				recordLifecycleEvent("sidebar.disposed", {
					surfaceId: this.surfaceId,
					isCurrentView: this.webview === webviewView,
					binding: sessionForChatSurface(this.surfaceId) ?? null,
				})
				if (this.webview === webviewView) {
					this.disposeView()
					// Cline Cubed: see the visibility handler above — closing the sidebar ends the
					// chat it holds, whichever event VS Code delivers for it.
					this.endSidebarChat("sidebar view disposed", webviewView)
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
			case "surfaceFocused": {
				// Cline Cubed: the person clicked into this chat. A sidebar view fires no focus event
				// the extension can hear, so the webview says so itself, and the claim is made here.
				setActiveChatSurface(this.surfaceId)
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
	 * closing the sidebar, closing a tab, or clicking the X ends the chat. Close means close.
	 *
	 * VS Code does not offer a "the user closed this view" event; it reports a view going away
	 * through onDidChangeVisibility or onDidDispose depending on the gesture, so both call here
	 * and this runs at most once per close (the binding is released before the end is recorded,
	 * so a second call finds nothing to end).
	 *
	 * The ONE case that is not a close: the user drags the view to the other sidebar, which
	 * destroys the view and creates a NEW one on this same provider. That is a move and the chat
	 * must survive it.
	 *
	 * A drag cannot be told apart at the moment the view goes away — nothing has happened yet that
	 * a close does not also do. The distinguishing fact arrives afterwards, on the NEW view: only
	 * a drag produces one. So the chat ENDS on the way out, and `rebindDraggedChat` brings it back
	 * when that new view proves the departure was a move (Doug, 2026-09-03). Two earlier attempts
	 * tried to decide it on the way out instead — one by waiting 1.5 seconds and asking a view
	 * that was gone whether it was visible, which never ended a closed chat at all; one by
	 * comparing view identity, which had nothing to compare yet and ended every dragged chat.
	 */
	private endSidebarChat(reason: string, closingView: vscode.WebviewView): void {
		const closingSessionId = sessionForChatSurface(this.surfaceId)
		recordLifecycleEvent("sidebar.endSidebarChat.armed", {
			surfaceId: this.surfaceId,
			reason,
			binding: closingSessionId ?? null,
		})
		if (typeof closingSessionId !== "string") {
			return
		}
		if (this.webview !== undefined && this.webview !== closingView) {
			// A newer view is already in place: this departure was overtaken by a re-resolve, so
			// the chat belongs to that view now and is not this one's to end.
			recordLifecycleEvent("sidebar.endSidebarChat.verdict", {
				surfaceId: this.surfaceId,
				reason,
				verdict: "superseded (not ours to end)",
				binding: closingSessionId,
			})
			return
		}
		recordLifecycleEvent("sidebar.endSidebarChat.verdict", {
			surfaceId: this.surfaceId,
			reason,
			verdict: "ENDING the chat",
			binding: closingSessionId,
		})
		// Remembered so a drag can be undone: the next view to arrive on this provider revives it.
		this.endedChatForRevival = closingSessionId
		bindChatSurfaceToSession(this.surfaceId, null)
		// The view may be hidden rather than destroyed — VS Code keeps a hidden view's context
		// alive — so its screen still shows the chat that just ended, and reopening the sidebar
		// would put that dead chat back in front of the user. Tell it to step back to the home.
		// Close means close.
		void this.postMessageToWebview({ type: "showNewChatHome" })
		this.controller.closeSession(closingSessionId).catch((error) => {
			Logger.error(`Failed to end session ${closingSessionId} (${reason}):`, error)
		})
	}

	/**
	 * Cline Cubed: rebind the chat a drag ended, so the replacement view is built on it.
	 *
	 * The end fires when a view goes away, because at that moment a drag and a close are
	 * indistinguishable; `endSidebarChat` copies the departing chat's id into this provider's own
	 * record before the shared erase runs. A NEW view arriving on this provider is the proof that
	 * it was a drag — VS Code creates one only when the view is moved between sidebars, never when
	 * it is closed. So the copied id is bound back to this surface here; the caller reads that
	 * binding into the view's identity and hydrates the transcript once the webview exists.
	 *
	 * Anything else — a close, then the sidebar opened again later — has nothing to rebind,
	 * because the copy is armed only by an end and is spent the moment it is used.
	 *
	 * @returns the rebound session id, or undefined when there was nothing to revive.
	 */
	private rebindDraggedChat(): string | undefined {
		const sessionId = this.endedChatForRevival
		this.endedChatForRevival = undefined
		if (sessionId === undefined) {
			return undefined
		}
		recordLifecycleEvent("sidebar.rebindDraggedChat", {
			surfaceId: this.surfaceId,
			binding: sessionId,
		})
		bindChatSurfaceToSession(this.surfaceId, sessionId)
		return sessionId
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
