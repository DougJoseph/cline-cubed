import { dirname, resolve as resolvePath } from "node:path"
import { type CoreSessionConfig, resolveCompactionTriggerTokens } from "@cline/core"
import type { StateManager } from "@/core/storage/StateManager"
import type { ClineMessage } from "@/shared/ExtensionMessage"
import { createAlwaysRememberedFilesExtension, isLocalEndpoint } from "./always-remembered-files"
import { buildSessionConfig, type SessionConfigInput } from "./cline-session-factory"
import { askMainModel, consentSuggestionMessage, createConsentSuggestionExtension } from "./consent-suggestion"
import { buildAgentHooks, type HookMessageEmitter } from "./hooks-adapter"
import { imageLimitsFromMegabytes } from "./image-descriptions"
import { createImageDescriptionsExtension } from "./image-descriptions-extension"
import type { ProviderConfigStore } from "./model-catalog/contracts"
import { NO_MODEL_SELECTED_ID, providerModelIsSetByProvider } from "./model-catalog/stored-mode-model"

export interface SdkSessionConfigBuilderOptions {
	stateManager: StateManager
	emitHookMessage: HookMessageEmitter
	/** Delivers a message to the chat of one session. */
	emitSessionMessage?: (message: ClineMessage, sessionId: string | undefined) => void
	onConsecutiveMistakeLimitReached?: CoreSessionConfig["onConsecutiveMistakeLimitReached"]
	/** Read by the image-descriptions extension for the Image Mode model and the main model's image support. */
	providerConfigStore?: ProviderConfigStore
}

/**
 * Unlike the CLI interactive runtime, plan-mode sessions do NOT expose a
 * switch_to_act_mode tool: matching the legacy extension, the model cannot
 * switch modes itself and must ask the user to flip the Plan/Act toggle. The
 * plan-mode system prompt (planModeSwitchTool: false in the session factory)
 * carries the matching instructions.
 */
export class SdkSessionConfigBuilder {
	constructor(private readonly options: SdkSessionConfigBuilderOptions) {}

	async build(input: SessionConfigInput): Promise<Awaited<ReturnType<typeof buildSessionConfig>>> {
		const config = await buildSessionConfig(input)
		if (config.providerId && !config.modelId && !providerModelIsSetByProvider(config.providerId)) {
			config.modelId = NO_MODEL_SELECTED_ID
		}
		if (this.options.onConsecutiveMistakeLimitReached) {
			config.onConsecutiveMistakeLimitReached = this.options.onConsecutiveMistakeLimitReached
		}

		config.hooks = buildAgentHooks(this.options.stateManager, this.options.emitHookMessage, input.cwd)

		const modelInfo = config.knownModels?.[config.modelId]
		// The user's image limits reach the engine's own budget, so the two agree.
		const limits = imageLimitsFromMegabytes({
			total: this.options.stateManager.getGlobalSettingsKey("imagesTotalLimitMb") ?? 8,
			perImageEncoded: this.options.stateManager.getGlobalSettingsKey("imagesPerImageLimitMb") ?? 5,
			perImageDecoded: this.options.stateManager.getGlobalSettingsKey("imagesPerImageDecodedLimitMb") ?? 6,
		})
		config.mediaBudget = {
			maxTotalMediaBytes: limits.maxTotalBytes,
			maxImageEncodedBytes: limits.maxImageEncodedBytes,
			maxImageDecodedBytes: limits.maxImageDecodedBytes,
		}
		// Cline Cubed: the Rules panel's on/off switches reach the engine. Read on every request,
		// so a switch applies to the next message in chats already open. Only a stored `false`
		// is off; a file the panel has never switched counts as on, as the panel shows it.
		const stateManager = this.options.stateManager
		const switchedOff = (toggles: Record<string, boolean> | undefined, paths: string[]) =>
			Object.entries(toggles ?? {}).some(([key, on]) => on === false && paths.includes(resolvePath(key)))
		config.isInstructionEnabled = (kind, filePath) => {
			if (kind === "rule") {
				const paths = [resolvePath(filePath)]
				return !(
					switchedOff(stateManager.getGlobalSettingsKey("globalClineRulesToggles"), paths) ||
					switchedOff(stateManager.getWorkspaceStateKey("localClineRulesToggles"), paths) ||
					switchedOff(stateManager.getWorkspaceStateKey("localAgentsRulesToggles"), paths)
				)
			}
			// The panel switches a skill by its folder; the engine names its SKILL.md file.
			const paths = [resolvePath(filePath), resolvePath(dirname(filePath))]
			return !(
				switchedOff(stateManager.getGlobalSettingsKey("globalSkillsToggles"), paths) ||
				switchedOff(stateManager.getWorkspaceStateKey("localSkillsToggles"), paths)
			)
		}
		const emitNotice = (text: string, sessionId: string | undefined) => {
			const message: ClineMessage = { ts: Date.now(), type: "say", say: "error", text, partial: false }
			if (this.options.emitSessionMessage) {
				this.options.emitSessionMessage(message, sessionId)
			} else {
				this.options.emitHookMessage(message)
			}
		}
		config.extensions = [
			...(config.extensions ?? []),
			createAlwaysRememberedFilesExtension({
				cwd: config.cwd,
				endpointIsLocal: isLocalEndpoint(config.providerId, config.baseUrl),
				compactionTriggerTokens: modelInfo ? resolveCompactionTriggerTokens(modelInfo) : undefined,
				emitWarning: (text, sessionId) => {
					const message: ClineMessage = { ts: Date.now(), type: "say", say: "error", text, partial: false }
					if (this.options.emitSessionMessage) {
						this.options.emitSessionMessage(message, sessionId)
					} else {
						this.options.emitHookMessage(message)
					}
				},
			}),
			createImageDescriptionsExtension({
				stateManager: this.options.stateManager,
				providerConfigStore: this.options.providerConfigStore,
				emitNotice,
			}),
			// Cline Cubed: a suggested consent reply for the chat input after a reply that asks for one.
			createConsentSuggestionExtension({
				enabled: () => this.options.stateManager.getGlobalSettingsKey("consentSuggestionEnabled") !== false,
				ask: (systemPrompt, userText) => askMainModel(this.options.stateManager, systemPrompt, userText),
				emit: (suggestion, sessionId) => {
					const message = consentSuggestionMessage(suggestion)
					if (this.options.emitSessionMessage) {
						this.options.emitSessionMessage(message, sessionId)
					} else {
						this.options.emitHookMessage(message)
					}
				},
			}),
		]

		return config
	}
}
