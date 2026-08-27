import { Empty } from "@shared/proto/cline/common"
import { AskResponseRequest } from "@shared/proto/cline/task"
import { Logger } from "@/shared/services/Logger"
import { ClineAskResponse } from "../../../shared/WebviewMessage"
import { interceptImagesForNonVisionModel } from "../../bridge/interceptImages"
import { Controller } from ".."

/**
 * Handles a response from the webview for a previous ask operation
 *
 * @param controller The controller instance
 * @param request The request containing response type, optional text and optional images
 * @returns Empty response
 */
export async function askResponse(controller: Controller, request: AskResponseRequest): Promise<Empty> {
	try {
		// Cline Cubed (V6): route to the TARGET session. Every chat-bound response carries the
		// surface's bound session id, so it can never land in another chat. Reinit the target
		// if it is not the active session, then respond.
		if (request.sessionId && controller.task?.taskId !== request.sessionId) {
			await controller.reinitExistingTaskFromId(request.sessionId)
		}

		if (!controller.task) {
			Logger.warn("askResponse: No active task to receive response")
			return Empty.create()
		}

		// Map the string responseType to the ClineAskResponse enum
		let responseType: ClineAskResponse
		switch (request.responseType) {
			case "yesButtonClicked":
				responseType = "yesButtonClicked"
				break
			case "noButtonClicked":
				responseType = "noButtonClicked"
				break
			case "messageResponse":
				responseType = "messageResponse"
				break
			default:
				Logger.warn(`askResponse: Unknown response type: ${request.responseType}`)
				return Empty.create()
		}

		// Cline Cubed: bridge images to text for the active model before the
		// message reaches it. Any interception failure degrades to the original
		// passthrough — the image bridge must never break a message send.
		let intercepted: { text: string; images: string[] } = {
			text: request.text ?? "",
			images: request.images ?? [],
		}
		try {
			intercepted = await interceptImagesForNonVisionModel({
				text: request.text ?? "",
				images: request.images ?? [],
				apiConfiguration: controller.stateManager.getApiConfiguration(),
				providerConfigStore: controller.getProviderConfigStore(),
				mode: controller.stateManager.getGlobalSettingsKey("mode"),
				debugEnabled: controller.stateManager.getGlobalSettingsKey("imageBridgeDebugEnabled"),
			})
		} catch (error) {
			Logger.warn("Image bridge interception skipped:", error)
		}

		// Call the task's handler for webview responses
		await controller.task.handleWebviewAskResponse(responseType, intercepted.text, intercepted.images, request.files)

		return Empty.create()
	} catch (error) {
		Logger.error("Error in askResponse handler:", error)
		throw error
	}
}
