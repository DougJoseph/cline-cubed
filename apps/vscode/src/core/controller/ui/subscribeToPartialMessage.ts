import { EmptyRequest } from "@shared/proto/cline/common"
import { ClineMessage } from "@shared/proto/cline/ui"
import { Logger } from "@/shared/services/Logger"
import { streamAcceptsSession } from "../chat-surfaces"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

// Keep track of active partial message subscriptions (gRPC streams)
const activePartialMessageSubscriptions = new Set<StreamingResponseHandler<ClineMessage>>()

// Keep track of callback-based subscriptions (for CLI and other non-gRPC consumers)
type PartialMessageCallback = (message: ClineMessage) => void
const callbackSubscriptions = new Set<PartialMessageCallback>()

/**
 * Subscribe to partial message events
 * @param controller The controller instance
 * @param request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The ID of the request (passed by the gRPC handler)
 */
export async function subscribeToPartialMessage(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<ClineMessage>,
	requestId?: string,
): Promise<void> {
	// Add this subscription to the active subscriptions
	activePartialMessageSubscriptions.add(responseStream)

	// Register cleanup when the connection is closed
	const cleanup = () => {
		activePartialMessageSubscriptions.delete(responseStream)
	}

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "partial_message_subscription" }, responseStream)
	}
}

/**
 * Send a partial message event to the subscribers that should see it.
 *
 * Cline Cubed: a streamed message belongs to exactly one conversation, so it is delivered only
 * to the chat surface showing that session. `sessionId` is the session the message came from;
 * untagged subscriptions (standalone host, CLI, tests) continue to receive everything.
 *
 * @param partialMessage The ClineMessage to send
 * @param sessionId The session this message belongs to
 */
export async function sendPartialMessageEvent(partialMessage: ClineMessage, sessionId?: string): Promise<void> {
	// FIRE-AND-FORGET: do NOT await delivery to the webview. The webview can be hidden,
	// reloaded, or closed, and VSCode's postMessage may hang or resolve false; awaiting it
	// could stall the backend's turn loop on a dead consumer. Correctness does not depend on
	// any single delivery arriving — the webview is a convergent replica that merges by id/seq
	// and reconciles from full state.
	for (const responseStream of activePartialMessageSubscriptions) {
		if (!streamAcceptsSession(responseStream, sessionId)) {
			continue
		}
		responseStream(
			partialMessage,
			false, // Not the last message
		).catch((error) => {
			Logger.error("Error sending partial message event:", error)
			// Remove the subscription if there was an error
			activePartialMessageSubscriptions.delete(responseStream)
		})
	}

	// Send to callback subscribers (synchronous)
	for (const callback of callbackSubscriptions) {
		try {
			callback(partialMessage)
		} catch (error) {
			Logger.error("Error in partial message callback:", error)
		}
	}
}
