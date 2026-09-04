import type { EmptyRequest } from "@shared/proto/cline/common"
import { Boolean } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import { getLatestAnnouncementId } from "@/utils/announcements"
import type { Controller } from "../index"

/**
 * Marks the current announcement as shown.
 *
 * Cline Cubed: the webview calls this when the What's New modal is CLOSED, not when it opens.
 * Every open chat surface is its own webview showing the same modal, so after recording the
 * version as seen the state is pushed to every surface, and each one closes its copy.
 *
 * @param controller The controller instance
 * @param _request The empty request (not used)
 * @returns Boolean indicating announcement should no longer be shown
 */
export async function onDidShowAnnouncement(controller: Controller, _request: EmptyRequest): Promise<Boolean> {
	try {
		const latestAnnouncementId = getLatestAnnouncementId()
		// Update the lastShownAnnouncementId to the current latestAnnouncementId
		controller.stateManager.setGlobalState("lastShownAnnouncementId", latestAnnouncementId)
		await controller.postStateToWebview()
		return Boolean.create({ value: false })
	} catch (error) {
		Logger.error("Failed to acknowledge announcement:", error)
		return Boolean.create({ value: false })
	}
}
