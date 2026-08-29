import { Empty, StringRequest } from "@shared/proto/cline/common"
import { Controller } from ".."

/**
 * Cancel a running task.
 *
 * Cline Cubed: the request carries the SESSION ID of the chat whose task to cancel — chats run
 * side by side, so Cancel pressed in one chat must abort THAT chat's turn, never whichever chat
 * happens to be active. An empty value keeps the
 * surface-less legacy contract: cancel the focused session.
 *
 * @param controller The controller instance
 * @param request The session id of the chat to cancel; empty = the focused session
 * @returns Empty response
 */
export async function cancelTask(controller: Controller, request: StringRequest): Promise<Empty> {
	await controller.cancelTask(request.value?.trim() || undefined)
	return Empty.create()
}
