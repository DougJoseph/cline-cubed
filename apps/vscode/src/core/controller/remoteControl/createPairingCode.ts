import type { EmptyRequest } from "@shared/proto/cline/common"
import { PairingCode } from "@shared/proto/cline/remote_control"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."
import { remoteControlManager } from "./remoteControlManager"

/** Asks the relay for a single-use pairing code for the popover to show, with the page's address. */
export async function createPairingCode(_controller: Controller, _request: EmptyRequest): Promise<PairingCode> {
	try {
		const created = await remoteControlManager.createPairingCode()
		return PairingCode.create({ code: created.code, expiresInSeconds: created.expiresInSeconds, pageUrl: created.pageUrl })
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		Logger.error(`Could not make a pairing code: ${message}`)
		return PairingCode.create({ error: message })
	}
}
