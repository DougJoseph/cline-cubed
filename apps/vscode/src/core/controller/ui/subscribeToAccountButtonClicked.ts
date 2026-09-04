import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import { requireTargetSurface, streamIsTargeted } from "../chat-surfaces"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

// Keep track of active account button clicked subscriptions
const activeAccountButtonClickedSubscriptions = new Set<StreamingResponseHandler<Empty>>()

/**
 * Subscribe to account button clicked events
 * @param controller The controller instance
 * @param request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The request ID for cleanup
 */
export async function subscribeToAccountButtonClicked(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<Empty>,
	requestId?: string,
): Promise<void> {
	// Add this subscription to the active subscriptions
	activeAccountButtonClickedSubscriptions.add(responseStream)

	// Register cleanup when the connection is closed
	const cleanup = () => {
		activeAccountButtonClickedSubscriptions.delete(responseStream)
	}

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "accountButtonClicked_subscription" }, responseStream)
	}
}

/**
 * Send an account button clicked event to all active subscribers
 */
export async function sendAccountButtonClickedEvent(targetSurfaceId?: string): Promise<void> {
	if (!requireTargetSurface("accountButtonClicked", targetSurfaceId)) {
		return
	}
	// Send the event to all active subscribers
	const promises = Array.from(activeAccountButtonClickedSubscriptions).map(async (responseStream) => {
		// Cline Cubed: a navigation event is aimed at ONE chat, not every open chat.
		if (!streamIsTargeted(responseStream, targetSurfaceId)) {
			return
		}
		try {
			const event = Empty.create({})
			await responseStream(
				event,
				false, // Not the last message
			)
		} catch (error) {
			Logger.error("Error sending accountButtonClicked event:", error)
			// Remove the subscription if there was an error
			activeAccountButtonClickedSubscriptions.delete(responseStream)
		}
	})

	await Promise.all(promises)
}
