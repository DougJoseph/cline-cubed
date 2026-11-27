import { Empty, type StringRequest } from "@shared/proto/cline/common"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."

/** Shows the saved installer in the operating system's file manager, for the popover's own button. */
export async function revealRelayInstaller(_controller: Controller, request: StringRequest): Promise<Empty> {
	if (request.value) {
		await HostProvider.window.revealFileInOs({ filePath: request.value }).catch((error) => {
			Logger.error(`Could not show the installer: ${error instanceof Error ? error.message : String(error)}`)
		})
	}
	return Empty.create({})
}
