import { Empty } from "@shared/proto/cline/common"
import { TaskTitleRequest } from "@shared/proto/cline/task"
import { Logger } from "@/shared/services/Logger"
import { Controller } from "../"

/**
 * Cline Cubed: rename a chat.
 *
 * A blank title is not an error — it CLEARS the chat's name, restoring its first prompt as the
 * displayed name. Only `taskId` is required.
 */
export async function setTaskTitle(controller: Controller, request: TaskTitleRequest): Promise<Empty> {
	if (!request.taskId) {
		Logger.error(`[setTaskTitle] Invalid request: taskId missing`)
		return Empty.create({})
	}

	try {
		await controller.setTaskTitle(request.taskId, request.title ?? "")
		return Empty.create({})
	} catch (error) {
		Logger.error("Error in setTaskTitle:", error)
		throw error
	}
}
