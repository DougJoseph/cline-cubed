import type { EmptyRequest } from "@shared/proto/cline/common"
import { PairedDevices } from "@shared/proto/cline/remote_control"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."
import { remoteControlManager } from "./remoteControlManager"

/** The devices paired with the relay, for the popover's list. */
export async function listPairedDevices(_controller: Controller, _request: EmptyRequest): Promise<PairedDevices> {
	try {
		return PairedDevices.create({ devices: await remoteControlManager.listDevices() })
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		Logger.error(`Could not list paired devices: ${message}`)
		return PairedDevices.create({ error: message })
	}
}
