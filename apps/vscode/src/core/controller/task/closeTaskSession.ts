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
			// Cline Cubed: no session id means there is nothing to close — close nothing. The
			// old fallback was a bare clearTask, which ends the ACTIVE session: a running chat
			// on some other surface died because a surface holding no chat sent a close.
			Logger.warn("closeTaskSession called with no session id; closing nothing")
		}
		return Empty.create()
	} catch (error) {
		Logger.error("Error in closeTaskSession handler:", error)
		throw error
	}
}
