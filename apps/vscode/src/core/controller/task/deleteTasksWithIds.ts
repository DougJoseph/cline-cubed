import { chatSurfaceForSession, evictSessionFromItsSurface } from "@core/controller/chat-surfaces"
import { Empty, StringArrayRequest } from "@shared/proto/cline/common"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Controller } from ".."

/**
 * Deletes tasks with the specified IDs
 * @param controller The controller instance
 * @param request The request containing an array of task IDs to delete
 * @returns Empty response
 * @throws Error if operation fails
 */
export async function deleteTasksWithIds(controller: Controller, request: StringArrayRequest): Promise<Empty> {
	if (!request.value || request.value.length === 0) {
		throw new Error("Missing task IDs")
	}

	// Cline Cubed: the confirmation names its blast radius. A chat being deleted may be OPEN
	// (its surface will step back to the Home) and may be RUNNING mid-turn (its run will be
	// stopped) — the user is deciding about live work, not only about a history record.
	const liveIds = new Set(controller.liveSessionIds())
	const openCount = request.value.filter((id) => chatSurfaceForSession(id) !== undefined).length
	const runningCount = request.value.filter((id) => liveIds.has(id)).length

	const taskCount = request.value.length
	let impact = ""
	if (taskCount === 1) {
		if (openCount > 0 && runningCount > 0) {
			impact = " This chat is open and currently running — deleting it will stop the run and close it."
		} else if (runningCount > 0) {
			impact = " This chat is currently running — deleting it will stop the run."
		} else if (openCount > 0) {
			impact = " This chat is open — deleting it will close it."
		}
	} else if (openCount > 0 || runningCount > 0) {
		const parts: string[] = []
		if (openCount > 0) {
			parts.push(`${openCount} ${openCount === 1 ? "is" : "are"} open and will be closed`)
		}
		if (runningCount > 0) {
			parts.push(`${runningCount} ${runningCount === 1 ? "is" : "are"} running and will be stopped`)
		}
		impact = ` Of these chats, ${parts.join("; ")}.`
	}
	const message =
		taskCount === 1
			? `Are you sure you want to delete this chat? This action cannot be undone.${impact}`
			: `Are you sure you want to delete these ${taskCount} chats? This action cannot be undone.${impact}`

	const userChoice = await HostProvider.window.showMessage({
		type: ShowMessageType.WARNING,
		message,
		options: { modal: true, items: ["Delete"] },
	})

	if (userChoice.selectedOption !== "Delete") {
		return Empty.create()
	}

	for (const id of request.value) {
		await deleteTaskWithId(controller, id)
	}

	return Empty.create()
}

/**
 * Deletes a single task with the specified ID.
 *
 * Cline Cubed: the delete is addressed by id at every step — the registry says which surface
 * shows the chat, and the session ends by its own id through the funnel. The old shape asked
 * the SINGLETON (`controller.task`) instead: with several chats open, deleting a chat whose
 * surface was not focused left that surface rendering the deleted record (typing there forked
 * a new chat behind it), while a singleton match fired a bare clear that could end whichever
 * session was focused — a different chat entirely.
 */
async function deleteTaskWithId(controller: Controller, id: string): Promise<void> {
	// 1. The surface showing this chat (if any) goes to its Home first — the user sees the
	//    chat honestly disappear, and nobody is left typing into a deleted transcript.
	evictSessionFromItsSurface(id)

	// 2. End the session BY ID through the funnel — a live one gets an honest end stamp
	//    (awaited, so the write lands before its rows are deleted); a non-live id ends
	//    nothing. Never the focused session: only the one being deleted.
	await controller.closeSession(id, { awaitStop: true })

	// 3. Remove task from state FIRST — this updates the in-memory cache
	// immediately so the next postStateToWebview() sends the updated list.
	await controller.deleteTaskFromState(id)

	// 4. Always update webview state so the history list and recents refresh
	await controller.postStateToWebview()
}
