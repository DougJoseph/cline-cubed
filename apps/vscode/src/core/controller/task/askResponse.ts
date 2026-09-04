import { Empty } from "@shared/proto/cline/common"
import { AskResponseRequest } from "@shared/proto/cline/task"
import { Logger } from "@/shared/services/Logger"
import { ClineAskResponse } from "../../../shared/WebviewMessage"
import { interceptImagesForNonVisionModel } from "../../bridge/interceptImages"
import { Controller } from ".."
import { chatSurfaceForSession, setActiveChatSurface } from "../chat-surfaces"

/**
 * Handles a response from the webview for a previous ask operation
 *
 * @param controller The controller instance
 * @param request The request containing response type, optional text and optional images
 * @returns Empty response
 */
export async function askResponse(controller: Controller, request: AskResponseRequest): Promise<Empty> {
	try {
		// Cline Cubed: address the response's OWN chat. Every chat-bound response carries the
		// session of the surface it was sent from, and it is delivered to that session's task —
		// the focused chat is never consulted, so a reply cannot land in a different conversation.
		// A session that is not resident is brought back first; only then does it receive the
		// response. A named session that STILL cannot be resolved is refused outright: falling
		// back to the focused task would deliver the message into a different conversation. The
		// bare `controller.task` branch below is the surface-less legacy contract (standalone
		// host, tests), where no session was named.
		const targetSessionId = request.sessionId?.trim()
		let task = targetSessionId ? controller.getTaskForSession(targetSessionId) : controller.task
		if (targetSessionId && !task) {
			await controller.reinitExistingTaskFromId(targetSessionId)
			task = controller.getTaskForSession(targetSessionId)
			if (!task) {
				Logger.error(
					`askResponse: Session ${targetSessionId} could not be revived; dropping the response rather than delivering it to another chat`,
				)
				return Empty.create()
			}
		}

		if (!task) {
			Logger.warn("askResponse: No task to receive response")
			return Empty.create()
		}

		// Sending a message is the one act that says, without inference, which chat the person is
		// working in. A session lives in exactly one surface, so this is exact — and it covers the
		// case that focus tracking cannot: returning to a chat bound long ago and typing into it.
		const sendingSurface = chatSurfaceForSession(task.taskId)
		if (sendingSurface) {
			setActiveChatSurface(sendingSurface)
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
				debugEnabled: controller.stateManager.getGlobalSettingsKey("debugLoggingEnabled"),
				sessionId: targetSessionId || task.taskId,
			})
		} catch (error) {
			Logger.warn("Image bridge interception skipped:", error)
		}

		// Call the task's handler for webview responses
		await task.handleWebviewAskResponse(responseType, intercepted.text, intercepted.images, request.files)

		return Empty.create()
	} catch (error) {
		Logger.error("Error in askResponse handler:", error)
		throw error
	}
}
