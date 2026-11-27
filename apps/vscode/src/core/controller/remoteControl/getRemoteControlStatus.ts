import type { EmptyRequest } from "@shared/proto/cline/common"
import type { RemoteControlStatus } from "@shared/proto/cline/remote_control"
import type { Controller } from ".."
import { remoteControlManager } from "./remoteControlManager"

/** The current remote-control state, for the composer affordance and its popover. */
export async function getRemoteControlStatus(_controller: Controller, _request: EmptyRequest): Promise<RemoteControlStatus> {
	return remoteControlManager.ensureRestored()
}
