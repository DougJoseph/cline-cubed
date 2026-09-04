import { Empty } from "@shared/proto/cline/common"
import { ResetStateRequest } from "@shared/proto/cline/state"
import { resetGlobalState, resetWorkspaceState } from "@/core/storage/utils/state-helpers"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { sendChatButtonClickedEvent } from "../ui/subscribeToChatButtonClicked"

/**
 * Resets the extension state to its defaults
 * @param controller The controller instance
 * @param request The reset state request containing the global flag
 * @returns An empty response
 */
export async function resetState(controller: Controller, request: ResetStateRequest): Promise<Empty> {
	try {
		// Cline Cubed: the most destructive action in the product had NO confirmation at all —
		// one click reset everything. It now confirms first, naming its blast radius: every
		// running chat is ended, and the stored state is gone for good.
		const runningCount = controller.liveSessionIds().length
		const impact =
			runningCount > 0 ? ` ${runningCount === 1 ? "1 running chat" : `${runningCount} running chats`} will be stopped.` : ""
		const userChoice = (
			await HostProvider.window.showMessage({
				type: ShowMessageType.WARNING,
				message: `Are you sure you want to reset ${request.global ? "global" : "workspace"} state? This cannot be undone.${impact}`,
				options: { modal: true, items: ["Reset"] },
			})
		).selectedOption
		if (userChoice !== "Reset") {
			return Empty.create()
		}

		if (request.global) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "Resetting global state...",
			})
			await resetGlobalState()
		} else {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "Resetting workspace state...",
			})
			await resetWorkspaceState()
		}

		// Cline Cubed: reset-everything means EVERY live session, each ended by its own id —
		// the old shape aborted only the focused singleton, so other running chats survived a
		// full state reset and kept streaming against wiped state.
		await controller.endAllSessions("resetState")

		HostProvider.window.showMessage({
			type: ShowMessageType.INFORMATION,
			message: "State reset",
		})
		await controller.postStateToWebview()

		await sendChatButtonClickedEvent()

		return Empty.create()
	} catch (error) {
		Logger.error("Error resetting state:", error)
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: `Failed to reset state: ${error instanceof Error ? error.message : String(error)}`,
		})
		throw error
	}
}
