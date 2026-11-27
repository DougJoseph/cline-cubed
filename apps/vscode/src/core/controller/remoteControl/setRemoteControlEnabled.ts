import type { BooleanRequest } from "@shared/proto/cline/common"
import type { RemoteControlStatus } from "@shared/proto/cline/remote_control"
import type { Controller } from ".."
import { remoteControlManager } from "./remoteControlManager"

/**
 * Turn remote control on or off for this machine. The choice is stored machine-wide so it survives a
 * VS Code window reload; the returned status is the confirmed state after the transport was started
 * or stopped, not the state that was requested.
 */
export async function setRemoteControlEnabled(controller: Controller, request: BooleanRequest): Promise<RemoteControlStatus> {
	const status = await remoteControlManager.setEnabled(request.value)
	// Push, not poll: every surface's badge is the host's state, so it cannot lag a change made from
	// another surface or from the composer command.
	await controller.postStateToWebview()
	return status
}
