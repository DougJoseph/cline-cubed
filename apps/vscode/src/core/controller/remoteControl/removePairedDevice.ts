import type { StringRequest } from "@shared/proto/cline/common"
import { PairedDevices } from "@shared/proto/cline/remote_control"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."
import { remoteControlManager } from "./remoteControlManager"

/** Unpairs one device; its next request to the relay is refused. Answers with the devices still paired. */
export async function removePairedDevice(_controller: Controller, request: StringRequest): Promise<PairedDevices> {
	try {
		return PairedDevices.create({ devices: await remoteControlManager.removeDevice(request.value) })
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		Logger.error(`Could not remove a paired device: ${message}`)
		return PairedDevices.create({ error: message })
	}
}
