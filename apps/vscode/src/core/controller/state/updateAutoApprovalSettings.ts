import { Empty } from "@shared/proto/cline/common"
import { AutoApprovalSettingsRequest } from "@shared/proto/cline/state"
import { Controller } from ".."

/**
 * Updates the auto approval settings
 * @param controller The controller instance
 * @param request The auto approval settings request
 * @returns Empty response
 */
export async function updateAutoApprovalSettings(controller: Controller, request: AutoApprovalSettingsRequest): Promise<Empty> {
	const currentSettings = (await controller.getStateToPostToWebview()).autoApprovalSettings
	const incomingVersion = request.version
	const currentVersion = currentSettings?.version ?? 1

	// Only update if incoming version is higher
	if (incomingVersion > currentVersion) {
		// Merge with current settings to preserve unspecified fields
		const settings = {
			...currentSettings,
			...(request.version !== undefined && { version: request.version }),
			...(request.enableNotifications !== undefined && { enableNotifications: request.enableNotifications }),
			actions: {
				...currentSettings.actions,
				...(request.actions
					? Object.fromEntries(Object.entries(request.actions).filter(([_, v]) => v !== undefined))
					: {}),
			},
		}

		controller.stateManager.setGlobalState("autoApprovalSettings", settings)
		// Cline Cubed: the per-task overlay is refreshed for EVERY live chat, each keyed by its
		// own taskId — writing only the focused chat's overlay left every other running chat on
		// the old auto-approval settings.
		controller.applyToLiveTasks((task) => {
			controller.stateManager.setTaskSettings(task.taskId, "autoApprovalSettings", settings)
		})

		await controller.postStateToWebview()
	}

	return Empty.create()
}
