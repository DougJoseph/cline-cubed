// Extracted from classic src/core/controller/index.ts (see origin/main)
//
// Standalone function to build ExtensionState from a Controller instance.
// This allows the SdkController to reuse the classic state-building logic
// without inheriting the entire classic Controller implementation.

import * as fs from "node:fs"
import * as path from "node:path"
import { isModelToolEnabledGlobally, readCompactionStrategyGlobally } from "@cline/core"
import { getBridgeDebugRuns } from "@core/bridge/bridgeDebug"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import type { ExtensionState, Platform } from "@shared/ExtensionMessage"
import { ClineEnv } from "@/config"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import { BannerService } from "@/services/banner/BannerService"
import { featureFlagsService } from "@/services/feature-flags"
import { getDistinctId } from "@/services/logging/distinctId"
import { getExtensionVariant } from "@/services/telemetry/rollout-metadata"
import { Logger } from "@/shared/services/Logger"
import { getLatestAnnouncementId } from "@/utils/announcements"
import { getClineOnboardingModels } from "../models/getClineOnboardingModels"

/**
 * Cline Cubed: the What's New notes for the running version, read once from the package's
 * `whats-new.md` (written at package time by `scripts/changelog-into-package.mjs`). The state is
 * rebuilt often, so the file is read on the first request and the result — including an empty
 * result for a missing file — is kept for the life of the process. A missing file is logged as an
 * error: a packaged build always carries it, and a development host never does.
 */
let whatsNewNotesCache: string | undefined

function readWhatsNewNotes(): string {
	if (whatsNewNotesCache !== undefined) {
		return whatsNewNotesCache
	}
	try {
		const file = path.join(HostProvider.get().extensionFsPath, "whats-new.md")
		try {
			whatsNewNotesCache = fs.readFileSync(file, "utf8")
		} catch (error) {
			Logger.error(`What's New notes are not readable at ${file}:`, error)
			whatsNewNotesCache = ""
		}
	} catch (error) {
		Logger.error("What's New notes could not be located — the host provider is not set up:", error)
		whatsNewNotesCache = ""
	}
	return whatsNewNotesCache
}

/** Whether this build carries What's New notes at all — a development host never does. */
export function hasWhatsNewNotes(): boolean {
	return readWhatsNewNotes().length > 0
}

/**
 * Builds the ExtensionState object to push to the webview.
 * Extracted from the classic Controller.getStateToPostToWebview().
 */
export async function getStateToPostToWebview(controller: {
	task?: any
	stateManager: any
	mcpHub?: any
	/** Cline Cubed: the active chat's own name, when it has been renamed. */
	getActiveTaskTitle?: () => string | undefined
	backgroundCommandRunning?: boolean
	backgroundCommandTaskId?: string
	foregroundCommandRunning?: boolean
	workspaceManager?: any
	checkpointRestoreInput?: ExtensionState["checkpointRestoreInput"]
	isRemoteConfigAvailable?: boolean
	currentRemoteConfigRevision?: number
}): Promise<ExtensionState> {
	const stateManager = controller.stateManager

	// Get API configuration from cache for immediate access
	const onboardingModels = getClineOnboardingModels()
	const apiConfiguration = stateManager.getApiConfiguration()
	const lastShownAnnouncementId = stateManager.getGlobalStateKey("lastShownAnnouncementId")
	const taskHistory = stateManager.getGlobalStateKey("taskHistory")
	const autoApprovalSettings = stateManager.getGlobalSettingsKey("autoApprovalSettings")
	const browserSettings = stateManager.getGlobalSettingsKey("browserSettings")
	const preferredLanguage = stateManager.getGlobalSettingsKey("preferredLanguage")
	// Cline Cubed: where a new chat session opens ("secondarySidebar" | "editor").
	const newChatLocation = stateManager.getGlobalSettingsKey("newChatLocation")
	const mode = stateManager.getGlobalSettingsKey("mode")
	const useAutoCondense = stateManager.getGlobalSettingsKey("useAutoCondense")
	const compactionStrategy = readCompactionStrategyGlobally()
	const webSearchEnabled = isModelToolEnabledGlobally("web_search")
	const subagentsEnabled = stateManager.getGlobalSettingsKey("subagentsEnabled")
	const userInfo = stateManager.getGlobalStateKey("userInfo")
	const mcpMarketplaceEnabled = stateManager.getGlobalStateKey("mcpMarketplaceEnabled")
	const mcpDisplayMode = stateManager.getGlobalStateKey("mcpDisplayMode")
	const telemetrySetting = stateManager.getGlobalSettingsKey("telemetrySetting")
	const planActSeparateModelsSetting = stateManager.getGlobalSettingsKey("planActSeparateModelsSetting")
	const enableCheckpointsSetting = stateManager.getGlobalSettingsKey("enableCheckpointsSetting")
	// Cline Cubed: the master debug-logging switch, plus the retained bridge
	// interception runs (the in-memory buffer; the webview shows a message's own
	// run inline next to its bridge block, whether or not logging is on).
	const debugLoggingEnabled = stateManager.getGlobalSettingsKey("debugLoggingEnabled")
	const globalClineRulesToggles = stateManager.getGlobalStateKey("globalClineRulesToggles")
	const globalWorkflowToggles = stateManager.getGlobalStateKey("globalWorkflowToggles")
	const globalSkillsToggles = stateManager.getGlobalStateKey("globalSkillsToggles")
	const localSkillsToggles = stateManager.getWorkspaceStateKey("localSkillsToggles")
	const remoteRulesToggles = stateManager.getGlobalStateKey("remoteRulesToggles")
	const remoteWorkflowToggles = stateManager.getGlobalStateKey("remoteWorkflowToggles")
	const shellIntegrationTimeout = stateManager.getGlobalSettingsKey("shellIntegrationTimeout")
	const terminalReuseEnabled = stateManager.getGlobalStateKey("terminalReuseEnabled")
	const vscodeTerminalExecutionMode = stateManager.getGlobalStateKey("vscodeTerminalExecutionMode")
	const defaultTerminalProfile = stateManager.getGlobalSettingsKey("defaultTerminalProfile")
	const isNewUser = stateManager.getGlobalStateKey("isNewUser")
	const welcomeViewCompleted = !!stateManager.getGlobalStateKey("welcomeViewCompleted")
	const clineCubedShowOnboarding = !!stateManager.getGlobalStateKey("clineCubedShowOnboarding")

	const mcpResponsesCollapsed = stateManager.getGlobalStateKey("mcpResponsesCollapsed")
	const favoritedModelIds = stateManager.getGlobalStateKey("favoritedModelIds")
	const lastDismissedInfoBannerVersion = stateManager.getGlobalStateKey("lastDismissedInfoBannerVersion") || 0
	const lastDismissedModelBannerVersion = stateManager.getGlobalStateKey("lastDismissedModelBannerVersion") || 0
	const lastDismissedCliBannerVersion = stateManager.getGlobalStateKey("lastDismissedCliBannerVersion") || 0
	const dismissedBanners = stateManager.getGlobalStateKey("dismissedBanners")
	const showFeatureTips = stateManager.getGlobalSettingsKey("showFeatureTips")

	const localClineRulesToggles = stateManager.getWorkspaceStateKey("localClineRulesToggles")
	const localWindsurfRulesToggles = stateManager.getWorkspaceStateKey("localWindsurfRulesToggles")
	const localCursorRulesToggles = stateManager.getWorkspaceStateKey("localCursorRulesToggles")
	const localAgentsRulesToggles = stateManager.getWorkspaceStateKey("localAgentsRulesToggles")
	const workflowToggles = stateManager.getWorkspaceStateKey("workflowToggles")

	const currentTaskItem = controller.task?.taskId
		? (taskHistory || []).find((item: any) => item.id === controller.task?.taskId)
		: undefined
	const clineMessages = [...(controller.task?.messageStateHandler?.getClineMessages?.() || [])]
	const checkpointRestoreInput = controller.checkpointRestoreInput

	const processedTaskHistory = (taskHistory || [])
		.filter((item: any) => item.ts && item.task)
		.sort((a: any, b: any) => b.ts - a.ts)
		.slice(0, 100)

	const latestAnnouncementId = getLatestAnnouncementId()
	const shouldShowAnnouncement = lastShownAnnouncementId !== latestAnnouncementId
	const platform = process.platform as Platform
	const distinctId = getDistinctId()
	const version = ExtensionRegistryInfo.version
	const clineConfig = ClineEnv.config()
	const environment = clineConfig.environment
	const banners = BannerService.get().getActiveBanners() ?? []
	const welcomeBanners = BannerService.get().getWelcomeBanners() ?? []

	// Check OpenAI Codex authentication status
	let openAiCodexIsAuthenticated = false
	try {
		const { openAiCodexOAuthManager } = await import("@/integrations/openai-codex/oauth")
		openAiCodexIsAuthenticated = await openAiCodexOAuthManager.isAuthenticated()
	} catch {
		// Codex OAuth not available
	}

	return {
		version,
		extensionVariant: getExtensionVariant(),
		apiConfiguration,
		currentTaskItem,
		/** Cline Cubed: the controller's LIVE task/session id when a task is active —
		 *  always present in a broadcast for an active task (unlike `currentTaskItem`, which
		 *  depends on the persisted taskHistory file and is undefined for new/streaming tasks).
		 *  Undefined when no task is active. This is what the per-surface binding gate keys on. */
		activeTaskId: controller.task?.taskId ?? undefined,
		/** Cline Cubed: the active chat's own name when it has been renamed; undefined means it is
		 *  still shown by its first prompt. Same reasoning as `activeTaskId` — `currentTaskItem`
		 *  cannot answer this for a new or streaming chat. */
		activeTaskTitle: controller.getActiveTaskTitle?.(),
		clineMessages,
		checkpointRestoreInput,
		autoApprovalSettings,
		browserSettings,
		preferredLanguage,
		newChatLocation,
		mode,
		useAutoCondense,
		compactionStrategy,
		webSearchEnabled,
		subagentsEnabled,
		userInfo,
		mcpMarketplaceEnabled,
		mcpDisplayMode,
		telemetrySetting,
		planActSeparateModelsSetting,
		enableCheckpointsSetting: enableCheckpointsSetting ?? true,
		// Cline Cubed: master debug logging + the inline bridge debug panel's data.
		debugLoggingEnabled,
		imageBridgeDebug: getBridgeDebugRuns(),
		platform,
		environment,
		distinctId,
		globalClineRulesToggles: globalClineRulesToggles || {},
		localClineRulesToggles: localClineRulesToggles || {},
		localWindsurfRulesToggles: localWindsurfRulesToggles || {},
		localCursorRulesToggles: localCursorRulesToggles || {},
		localAgentsRulesToggles: localAgentsRulesToggles || {},
		localWorkflowToggles: workflowToggles || {},
		globalWorkflowToggles: globalWorkflowToggles || {},
		globalSkillsToggles: globalSkillsToggles || {},
		localSkillsToggles: localSkillsToggles || {},
		remoteRulesToggles,
		remoteWorkflowToggles,
		shellIntegrationTimeout,
		terminalReuseEnabled,
		vscodeTerminalExecutionMode,
		defaultTerminalProfile,
		isNewUser,
		welcomeViewCompleted,
		clineCubedShowOnboarding,
		onboardingModels,
		mcpResponsesCollapsed,
		taskHistory: processedTaskHistory,
		shouldShowAnnouncement,
		favoritedModelIds,
		backgroundCommandRunning: controller.backgroundCommandRunning ?? false,
		backgroundCommandTaskId: controller.backgroundCommandTaskId,
		foregroundCommandRunning: controller.foregroundCommandRunning ?? false,
		workspaceRoots: controller.workspaceManager?.getRoots?.() ?? [],
		primaryRootIndex: controller.workspaceManager?.getPrimaryIndex?.() ?? 0,
		isMultiRootWorkspace: (controller.workspaceManager?.getRoots?.()?.length ?? 0) > 1,
		multiRootSetting: {
			user: stateManager.getGlobalStateKey("multiRootEnabled"),
			featureFlag: true,
		},
		worktreesEnabled: {
			user: stateManager.getGlobalSettingsKey("worktreesEnabled"),
			featureFlag: featureFlagsService.getWorktreesEnabled(),
		},
		hooksEnabled: getHooksEnabledSafe(stateManager.getGlobalSettingsKey("hooksEnabled")),
		lastDismissedInfoBannerVersion,
		lastDismissedModelBannerVersion,
		remoteConfigSettings: stateManager.getRemoteConfigSettings?.(),
		remoteConfigRevision: controller.currentRemoteConfigRevision ?? 0,
		lastDismissedCliBannerVersion,
		dismissedBanners,
		backgroundEditEnabled: stateManager.getGlobalSettingsKey("backgroundEditEnabled"),
		optOutOfRemoteConfig: stateManager.getGlobalSettingsKey("optOutOfRemoteConfig"),
		remoteConfigAvailable: controller.isRemoteConfigAvailable ?? false,
		showFeatureTips,
		banners,
		welcomeBanners,
		whatsNewNotes: readWhatsNewNotes(),
		openAiCodexIsAuthenticated,
	} as ExtensionState
}
