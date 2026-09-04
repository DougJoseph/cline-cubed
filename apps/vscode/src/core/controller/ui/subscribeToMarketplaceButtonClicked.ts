import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import { requireTargetSurface, streamIsTargeted } from "../chat-surfaces"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

const activeMarketplaceButtonClickedSubscriptions = new Set<StreamingResponseHandler<Empty>>()

export async function subscribeToMarketplaceButtonClicked(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<Empty>,
	requestId?: string,
): Promise<void> {
	activeMarketplaceButtonClickedSubscriptions.add(responseStream)

	const cleanup = () => {
		activeMarketplaceButtonClickedSubscriptions.delete(responseStream)
	}

	if (requestId) {
		getRequestRegistry().registerRequest(
			requestId,
			cleanup,
			{ type: "marketplaceButtonClicked_subscription" },
			responseStream,
		)
	}
}

export async function sendMarketplaceButtonClickedEvent(targetSurfaceId?: string): Promise<void> {
	if (!requireTargetSurface("marketplaceButtonClicked", targetSurfaceId)) {
		return
	}
	const promises = Array.from(activeMarketplaceButtonClickedSubscriptions).map(async (responseStream) => {
		// Cline Cubed: a navigation event is aimed at ONE chat, not every open chat.
		if (!streamIsTargeted(responseStream, targetSurfaceId)) {
			return
		}
		try {
			await responseStream(Empty.create({}), false)
		} catch (error) {
			Logger.error("Error sending marketplaceButtonClicked event:", error)
			activeMarketplaceButtonClickedSubscriptions.delete(responseStream)
		}
	})

	await Promise.all(promises)
}
