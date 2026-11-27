import type { EmptyRequest } from "@shared/proto/cline/common"
import type { RemoteControlStatus } from "@shared/proto/cline/remote_control"
import type { Controller } from ".."
import { remoteControlManager } from "./remoteControlManager"

/** Flips remote control from its current value and returns the confirmed state. */
export async function toggleRemoteControl(controller: Controller, _request: EmptyRequest): Promise<RemoteControlStatus> {
	const status = await remoteControlManager.toggle()
	// Push, not poll: every surface's badge is the host's state, so it cannot lag a change made from
	// another surface or from the composer command.
	await controller.postStateToWebview()
	return status
}
