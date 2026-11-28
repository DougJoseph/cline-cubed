import type { EmptyRequest } from "@shared/proto/cline/common"
import type { RemoteControlStatus } from "@shared/proto/cline/remote_control"
import type { Controller } from ".."
import { remoteControlManager } from "./remoteControlManager"

/** The relay notice popup was closed or acted on, so it does not open again on this connection. */
export async function dismissRelayNotice(_controller: Controller, _request: EmptyRequest): Promise<RemoteControlStatus> {
	return remoteControlManager.dismissRelayNotice()
}
