import { interceptImagesForNonVisionModel } from "@core/bridge/interceptImages"
import { Controller } from "@core/controller"
import { sendChatButtonClickedEvent } from "@core/controller/ui/subscribeToChatButtonClicked"
import { Logger } from "@/shared/services/Logger"
import { ClineAPI } from "./cline"

export function createClineAPI(sidebarController: Controller): ClineAPI {
	// Cline Cubed: bridge images to text for the active model before the
	// message reaches it. Any interception failure degrades to the original
	// passthrough — the image bridge must never break an API call.
	const intercept = async (message: string, images: string[]): Promise<{ text: string; images: string[] }> => {
		try {
			return await interceptImagesForNonVisionModel({
				text: message,
				images,
				apiConfiguration: sidebarController.stateManager.getApiConfiguration(),
				providerConfigStore: sidebarController.getProviderConfigStore(),
				mode: sidebarController.stateManager.getGlobalSettingsKey("mode"),
				debugEnabled: sidebarController.stateManager.getGlobalSettingsKey("debugLoggingEnabled"),
			})
		} catch (error) {
			Logger.warn("Image bridge interception skipped:", error)
			return { text: message, images }
		}
	}

	const api: ClineAPI = {
		startNewTask: async (task?: string, images?: string[]) => {
			// Cline Cubed: another extension starting a task must not end a chat the user has
			// running — this view-only clear names no session, so it ends none by construction.
			await sidebarController.clearTask({})
			await sidebarController.postStateToWebview()

			await sendChatButtonClickedEvent()
			const bridged = await intercept(task || "", images || [])
			await sidebarController.initTask(bridged.text, bridged.images)
		},

		sendMessage: async (message?: string, images?: string[]) => {
			if (sidebarController.task) {
				const bridged = await intercept(message || "", images || [])
				await sidebarController.task.handleWebviewAskResponse("messageResponse", bridged.text, bridged.images)
			} else {
				Logger.error("No active task to send message to")
			}
		},

		pressPrimaryButton: async () => {
			if (sidebarController.task) {
				await sidebarController.task.handleWebviewAskResponse("yesButtonClicked", "", [])
			} else {
				Logger.error("No active task to press button for")
			}
		},

		pressSecondaryButton: async () => {
			if (sidebarController.task) {
				await sidebarController.task.handleWebviewAskResponse("noButtonClicked", "", [])
			} else {
				Logger.error("No active task to press button for")
			}
		},
	}

	return api
}
