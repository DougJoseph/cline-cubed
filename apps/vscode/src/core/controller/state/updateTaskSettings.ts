import { Empty } from "@shared/proto/cline/common"
import { PlanActMode, UpdateTaskSettingsRequest } from "@shared/proto/cline/state"
import { convertProtoToApiProvider } from "@shared/proto-conversions/models/api-configuration-conversion"
import { Mode } from "@/shared/storage/types"
import { Controller } from ".."
import { normalizeOpenaiReasoningEffort } from "./reasoningEffort"

/**
 * Updates task-specific settings for the current task
 * @param controller The controller instance
 * @param request The request containing the task settings to update
 * @returns An empty response
 */
export async function updateTaskSettings(controller: Controller, request: UpdateTaskSettingsRequest): Promise<Empty> {
	const convertPlanActMode = (mode: PlanActMode): Mode => {
		return mode === PlanActMode.PLAN ? "plan" : "act"
	}

	try {
		// Cline Cubed: a request naming a task targets THAT task. A request naming none is the
		// legacy single-chat shape — under concurrency it applies to EVERY live chat, each keyed
		// by its own taskId, never silently to whichever chat happens to be focused (the
		// approved 2026-08-30 rule: a config event acts on the named session, every session, or
		// none). The settings land immediately, not on some later turn.
		const targetTaskIds: string[] = []
		if (request.taskId) {
			targetTaskIds.push(request.taskId)
		} else {
			controller.applyToLiveTasks((task) => targetTaskIds.push(task.taskId))
			if (targetTaskIds.length === 0) {
				throw new Error("No task to update settings for")
			}
		}

		if (request.settings) {
			// Extract all special case fields that need dedicated handlers
			const settingsForTasks = request.settings
			const {
				// Fields requiring conversion
				autoApprovalSettings,
				planModeReasoningEffort,
				actModeReasoningEffort,
				mode,
				planModeApiProvider,
				actModeApiProvider,
				// Fields requiring special logic
				browserSettings,
				...simpleSettings
			} = settingsForTasks

			// Batch update for simple pass-through fields
			const filteredSettings: any = Object.fromEntries(
				Object.entries(simpleSettings).filter(([key, value]) => key !== "openaiReasoningEffort" && value !== undefined),
			)

			for (const taskId of targetTaskIds) {
				controller.stateManager.setTaskSettingsBatch(taskId, filteredSettings)

				// Handle fields requiring type conversion from generated protobuf types to application types
				if (autoApprovalSettings) {
					// Merge with current settings to preserve unspecified fields
					const currentAutoApprovalSettings = controller.stateManager.getGlobalSettingsKey("autoApprovalSettings")
					const mergedSettings = {
						...currentAutoApprovalSettings,
						...(autoApprovalSettings.version !== undefined && { version: autoApprovalSettings.version }),
						...(autoApprovalSettings.enableNotifications !== undefined && {
							enableNotifications: autoApprovalSettings.enableNotifications,
						}),
						actions: {
							...currentAutoApprovalSettings.actions,
							...(autoApprovalSettings.actions
								? Object.fromEntries(
										Object.entries(autoApprovalSettings.actions).filter(([_, v]) => v !== undefined),
									)
								: {}),
						},
					}
					controller.stateManager.setTaskSettings(taskId, "autoApprovalSettings", mergedSettings)
				}

				if (planModeReasoningEffort !== undefined) {
					const converted = normalizeOpenaiReasoningEffort(planModeReasoningEffort)
					controller.stateManager.setTaskSettings(taskId, "planModeReasoningEffort", converted)
				}

				if (actModeReasoningEffort !== undefined) {
					const converted = normalizeOpenaiReasoningEffort(actModeReasoningEffort)
					controller.stateManager.setTaskSettings(taskId, "actModeReasoningEffort", converted)
				}

				if (mode !== undefined) {
					const converted = convertPlanActMode(mode)
					controller.stateManager.setTaskSettings(taskId, "mode", converted)
				}

				if (planModeApiProvider !== undefined) {
					const converted = convertProtoToApiProvider(planModeApiProvider)
					controller.stateManager.setTaskSettings(taskId, "planModeApiProvider", converted)
				}

				if (actModeApiProvider !== undefined) {
					const converted = convertProtoToApiProvider(actModeApiProvider)
					controller.stateManager.setTaskSettings(taskId, "actModeApiProvider", converted)
				}

				// Update browser settings (requires careful merging to avoid protobuf defaults)
				if (browserSettings !== undefined) {
					const currentSettings = controller.stateManager.getGlobalSettingsKey("browserSettings")

					const newBrowserSettings = {
						...currentSettings,
						viewport: {
							width: browserSettings.viewport?.width || currentSettings.viewport.width,
							height: browserSettings.viewport?.height || currentSettings.viewport.height,
						},
						...(browserSettings.remoteBrowserEnabled !== undefined && {
							remoteBrowserEnabled: browserSettings.remoteBrowserEnabled,
						}),
						...(browserSettings.remoteBrowserHost !== undefined && {
							remoteBrowserHost: browserSettings.remoteBrowserHost,
						}),
						...(browserSettings.chromeExecutablePath !== undefined && {
							chromeExecutablePath: browserSettings.chromeExecutablePath,
						}),
						...(browserSettings.disableToolUse !== undefined && {
							disableToolUse: browserSettings.disableToolUse,
						}),
						...(browserSettings.customArgs !== undefined && {
							customArgs: browserSettings.customArgs,
						}),
					}

					controller.stateManager.setTaskSettings(taskId, "browserSettings", newBrowserSettings)
				}
			}
		}

		// Post updated state to webview
		await controller.postStateToWebview()

		return Empty.create()
	} catch (error) {
		throw error
	}
}
