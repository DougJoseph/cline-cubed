import type { ChatShareRequest, RemoteControlStatus } from "@shared/proto/cline/remote_control"
import type { Controller } from ".."
import { remoteControlManager } from "./remoteControlManager"

/** Shares one chat with paired devices, or stops sharing it, and pushes the new state to every surface. */
export async function setChatShared(controller: Controller, request: ChatShareRequest): Promise<RemoteControlStatus> {
	const status = await remoteControlManager.setChatShared(request.sessionId, request.shared)
	await controller.postStateToWebview()
	return status
}
