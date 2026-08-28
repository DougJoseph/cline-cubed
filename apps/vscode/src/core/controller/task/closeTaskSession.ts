import { Empty, StringRequest } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/**
 * Cline Cubed: close ONE chat session, addressed by id.
 *
 * The in-chat close control belongs to a specific chat surface, and chats run side by side —
 * so the close must end THAT surface's session. `clearTask` ends whichever session is focused,
 * which with several chats open can be a different chat entirely.
 *
 * The closing webview shows its home locally and reports its binding change itself
 * (`bindSurfaceSession`), so no webview targeting is needed here.
 */
export async function closeTaskSession(controller: Controller, request: StringRequest): Promise<Empty> {
	try {
		const sessionId = request.value?.trim()
		if (sessionId) {
			await controller.closeSession(sessionId)
		} else {
			// No session id — a chat that never got a binding. Fall back to the legacy clear.
			await controller.clearTask()
		}
		return Empty.create()
	} catch (error) {
		Logger.error("Error in closeTaskSession handler:", error)
		throw error
	}
}
