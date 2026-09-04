import { Empty, StringRequest } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/**
 * Clears the task view — and ends a session ONLY when the request names one.
 *
 * Cline Cubed: `request.value` is the SESSION ID of the chat whose session to end along with
 * the clear. Sessions end only by explicit id (no session action without a session id,
 * 2026-08-31); an empty value clears the view and ends nothing. Concurrent surfaces close
 * their chats through `closeTaskSession`; the id here comes from single-chat hosts, where the
 * focused task is the only chat there is.
 */
export async function clearTask(controller: Controller, request: StringRequest): Promise<Empty> {
	const startedAt = Date.now()
	const endSessionId = request.value?.trim()
	await controller.clearTask(endSessionId ? { endSessionId } : {})
	const afterClearTask = Date.now()
	await controller.postStateToWebview()
	const totalElapsed = Date.now() - startedAt

	if (totalElapsed > 250) {
		Logger.warn(
			`[TaskService.clearTask] took ${totalElapsed}ms (controller.clearTask=${afterClearTask - startedAt}ms, postStateToWebview=${Date.now() - afterClearTask}ms)`,
		)
	}

	return Empty.create()
}
