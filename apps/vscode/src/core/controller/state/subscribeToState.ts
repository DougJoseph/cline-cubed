import { CONVERSATION_FIELDS } from "@shared/conversation-snapshot"
import { EmptyRequest } from "@shared/proto/cline/common"
import { State } from "@shared/proto/cline/state"
import { telemetryService } from "@/services/telemetry"
import { ExtensionState } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { sessionForStream } from "../chat-surfaces"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

// Keep track of active state subscriptions
const activeStateSubscriptions = new Set<StreamingResponseHandler<State>>()

/**
 * Subscribe to state updates
 * @param controller The controller instance
 * @param request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The ID of the request (passed by the gRPC handler)
 */
export async function subscribeToState(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<State>,
	requestId?: string,
): Promise<void> {
	// Add this subscription to the active subscriptions
	activeStateSubscriptions.add(responseStream)

	// Register cleanup when the connection is closed
	const cleanup = () => {
		activeStateSubscriptions.delete(responseStream)
	}

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "state_subscription" }, responseStream)
	}

	// Send the initial state — built for the session THIS surface is showing.
	//
	// The subscribing stream is already tagged with its chat surface (the gRPC layer tags it
	// before this handler runs), so a newly opened chat starts on the home instead of inheriting
	// whichever conversation happens to be focused.
	const surfaceSession = sessionForStream(responseStream)
	let initialState: ExtensionState | Partial<ExtensionState>
	if (surfaceSession === undefined) {
		// No surface identity — outside the per-surface model (standalone host, CLI, tests).
		initialState = await controller.getStateToPostToWebview()
	} else if (surfaceSession === null) {
		// A new chat: settings and UI state, but no conversation.
		initialState = withoutConversation(await controller.getStateToPostToWebview())
	} else {
		initialState = await controller.getStateToPostToWebview(surfaceSession)
	}
	const initialStateJson = JSON.stringify(initialState)

	recordStateSizeTelemetry(Buffer.byteLength(initialStateJson, "utf8"))

	try {
		await responseStream(
			{
				stateJson: initialStateJson,
			},
			false, // Not the last message
		)
	} catch (error) {
		Logger.error("Error sending initial state:", error)
		activeStateSubscriptions.delete(responseStream)
	}
}

/**
 * A surface showing the new-chat home needs settings/model/UI state but no conversation.
 * The field list lives in shared/conversation-snapshot.ts — the single source for the
 * three-answer wire contract; deleting the keys (rather than sending empty ones) lets the
 * webview leave whatever it is displaying alone. The home form also drops the loading flag:
 * a surface on the Home is not waiting for anything.
 */
function withoutConversation(state: ExtensionState): Partial<ExtensionState> {
	const copy: Record<string, unknown> = { ...state }
	for (const field of CONVERSATION_FIELDS) {
		delete copy[field]
	}
	delete copy.conversationLoading
	return copy as Partial<ExtensionState>
}

/**
 * Send a state update to the subscribers that should see it.
 *
 * Every subscription belongs to a chat surface, and each surface receives a snapshot built for
 * the session IT is showing — so a chat renders its own conversation and never another's.
 *
 * - `sessionId` names the session whose state changed. Surfaces showing a DIFFERENT session are
 *   given their own snapshot instead, via `buildForSession`, so an update for one chat never
 *   blanks or overwrites another.
 * - When `sessionId` is omitted the update is not tied to a particular chat, so every surface is
 *   served its own session's snapshot.
 * - A surface on the new-chat home gets the snapshot with conversation fields omitted.
 * - A surface whose session cannot be built (`buildForSession` returns null — the session is not
 *   resident) ALSO gets the conversation-omitted snapshot, so it keeps what it is displaying.
 * - Without a `buildForSession`, a surface bound to a different session gets the
 *   conversation-omitted snapshot — NEVER another session's payload.
 * - A subscription with no surface identity (standalone host, CLI, tests) gets `state` unchanged.
 *
 * @param state The snapshot for `sessionId`, and the fallback for identity-less subscriptions
 * @param sessionId The session whose conversation `state` carries
 * @param buildForSession Builds a snapshot for another session; null = that session is not resident
 */
export async function sendStateUpdate(
	state: ExtensionState,
	sessionId?: string,
	buildForSession?: (sessionId: string) => Promise<ExtensionState | null>,
): Promise<void> {
	const serialize = (value: ExtensionState | Partial<ExtensionState>): string | undefined => {
		try {
			return JSON.stringify(value)
		} catch (error) {
			Logger.error("Error serializing state update:", error)
			return undefined
		}
	}

	const defaultJson = serialize(state)
	if (defaultJson === undefined) {
		return
	}
	recordStateSizeTelemetry(Buffer.byteLength(defaultJson, "utf8"))

	let homeJson: string | undefined
	const perSessionJson = new Map<string, string | undefined>()
	if (sessionId !== undefined) {
		perSessionJson.set(sessionId, defaultJson)
	}

	for (const responseStream of activeStateSubscriptions) {
		const surfaceSession = sessionForStream(responseStream)

		let payload: string | undefined
		if (surfaceSession === undefined) {
			// No surface identity — outside the per-surface model.
			payload = defaultJson
		} else if (surfaceSession === null) {
			// Showing the new-chat home.
			homeJson ??= serialize(withoutConversation(state))
			payload = homeJson
		} else if (perSessionJson.has(surfaceSession)) {
			payload = perSessionJson.get(surfaceSession)
		} else if (buildForSession) {
			// This surface shows a different chat — serve it that chat's own snapshot. A null
			// build (session not resident) degrades to the conversation-omitted snapshot so the
			// surface keeps what it is displaying.
			try {
				const built = await buildForSession(surfaceSession)
				if (built === null) {
					homeJson ??= serialize(withoutConversation(state))
					payload = homeJson
				} else {
					payload = serialize(built)
				}
			} catch (error) {
				Logger.error("Error building state for session:", error)
				payload = undefined
			}
			perSessionJson.set(surfaceSession, payload)
		} else {
			// No builder available — never hand this surface another session's conversation.
			homeJson ??= serialize(withoutConversation(state))
			payload = homeJson
		}

		if (payload === undefined) {
			continue
		}

		// FIRE-AND-FORGET: do not await delivery to the webview (it may be hidden/reloaded/closed
		// and postMessage can hang or resolve false). The webview reconciles convergently from
		// whatever state snapshots it receives, gated by stateVersion/epoch.
		responseStream({ stateJson: payload }, false).catch((error) => {
			Logger.error("Error sending state update:", error)
			activeStateSubscriptions.delete(responseStream)
		})
	}
}

function recordStateSizeTelemetry(sizeBytes: number): void {
	telemetryService.captureGrpcResponseSize(sizeBytes, "cline.StateService", "subscribeToState")
}
