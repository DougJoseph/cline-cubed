import { StringRequest } from "@shared/proto/cline/common"
import { TaskResponse } from "@shared/proto/cline/task"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/**
 * Shows a task with the specified ID by loading its messages from disk.
 * Task lookup/loading is delegated to the SDK-backed controller.
 *
 * Cline Cubed: this unary RPC carries NO surface identity, so the host cannot know which chat
 * surface asked — it used to fire a chatButtonClicked at `getActiveChatSurface()`, a guess from a
 * global that panel focus mutates, which could navigate a DIFFERENT surface to its chat view. The
 * CALLER navigates itself instead (it knows it clicked); the host only loads the task.
 */
export async function showTaskWithId(controller: Controller, request: StringRequest): Promise<TaskResponse> {
	try {
		return await controller.showTaskWithId(request.value)
	} catch (error) {
		Logger.error("Error in showTaskWithId:", error)
		throw error
	}
}
