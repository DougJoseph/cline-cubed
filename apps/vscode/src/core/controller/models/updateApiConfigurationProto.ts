import { Empty } from "@shared/proto/cline/common"
import type { UpdateApiConfigurationRequest } from "@shared/proto/cline/models"
import { convertProtoToApiProvider } from "@shared/proto-conversions/models/api-configuration-conversion"
import {
	fromProtobufLiteLLMModelInfo,
	fromProtobufModelInfo,
	fromProtobufOcaModelInfo,
	fromProtobufOpenAiCompatibleModelInfo,
} from "@shared/proto-conversions/models/typeConversion"
import { OpenaiReasoningEffort } from "@shared/storage/types"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"
import { clearOrganizationForClinePassProviderSelection } from "./handleClinePassProviderSelection"
import { normalizeProviderSwitchModel } from "./providerSwitchNormalization"
import { createTaskApiModelShim, resolveActiveModelIdFromApiConfiguration } from "./taskApiModel"

/**
 * Updates API configuration
 * @param controller The controller instance
 * @param request The update API configuration request
 * @returns Empty response
 */
export async function updateApiConfigurationProto(
	controller: Controller,
	request: UpdateApiConfigurationRequest,
): Promise<Empty> {
	try {
		if (!request.apiConfiguration) {
			Logger.log("[APICONFIG: updateApiConfigurationProto] API configuration is required")
			throw new Error("API configuration is required")
		}

		const protoApiConfiguration = request.apiConfiguration

		const convertedApiConfigurationFromProto = {
			...protoApiConfiguration,
			// Convert proto ApiProvider enums to native string types
			planModeApiProvider:
				protoApiConfiguration.planModeApiProvider !== undefined
					? convertProtoToApiProvider(protoApiConfiguration.planModeApiProvider!)
					: undefined,
			actModeApiProvider:
				protoApiConfiguration.actModeApiProvider !== undefined
					? convertProtoToApiProvider(protoApiConfiguration.actModeApiProvider!)
					: undefined,
			// Cline Cubed: convert the Image Mode provider enum like the
			// plan/act providers above (the raw proto spread would otherwise
			// carry it through as a plain string).
			imageModeApiProvider:
				protoApiConfiguration.imageModeApiProvider !== undefined
					? convertProtoToApiProvider(protoApiConfiguration.imageModeApiProvider!)
					: undefined,
			// Cline Cubed: convert the Image Mode model info (the raw proto spread
			// would carry it as a proto object, not a ModelInfo).
			imageModeApiModelInfo: protoApiConfiguration.imageModeApiModelInfo
				? fromProtobufModelInfo(protoApiConfiguration.imageModeApiModelInfo)
				: undefined,
			imageModeReasoningEffort: protoApiConfiguration.imageModeApiReasoningEffort as OpenaiReasoningEffort | undefined,

			// Convert ModelInfo objects (empty arrays → undefined)
			// Plan Mode
			planModeOpenRouterModelInfo: protoApiConfiguration.planModeOpenRouterModelInfo
				? fromProtobufModelInfo(protoApiConfiguration.planModeOpenRouterModelInfo)
				: undefined,
			planModeClineModelInfo: protoApiConfiguration.planModeClineModelInfo
				? fromProtobufModelInfo(protoApiConfiguration.planModeClineModelInfo)
				: undefined,
			planModeClinePassModelInfo: protoApiConfiguration.planModeClinePassModelInfo
				? fromProtobufModelInfo(protoApiConfiguration.planModeClinePassModelInfo)
				: undefined,
			planModeOpenAiModelInfo: protoApiConfiguration.planModeOpenAiModelInfo
				? fromProtobufOpenAiCompatibleModelInfo(protoApiConfiguration.planModeOpenAiModelInfo)
				: undefined,
			planModeHuggingFaceModelInfo: protoApiConfiguration.planModeHuggingFaceModelInfo
				? fromProtobufModelInfo(protoApiConfiguration.planModeHuggingFaceModelInfo)
				: undefined,
			planModeLiteLlmModelInfo: protoApiConfiguration.planModeLiteLlmModelInfo
				? fromProtobufLiteLLMModelInfo(protoApiConfiguration.planModeLiteLlmModelInfo)
				: undefined,
			planModeRequestyModelInfo: protoApiConfiguration.planModeRequestyModelInfo
				? fromProtobufModelInfo(protoApiConfiguration.planModeRequestyModelInfo)
				: undefined,
			planModeGroqModelInfo: protoApiConfiguration.planModeGroqModelInfo
				? fromProtobufModelInfo(protoApiConfiguration.planModeGroqModelInfo)
				: undefined,
			planModeHuaweiCloudMaasModelInfo: protoApiConfiguration.planModeHuaweiCloudMaasModelInfo
				? fromProtobufModelInfo(protoApiConfiguration.planModeHuaweiCloudMaasModelInfo)
				: undefined,
			planModeBasetenModelInfo: protoApiConfiguration.planModeBasetenModelInfo
				? fromProtobufModelInfo(protoApiConfiguration.planModeBasetenModelInfo)
				: undefined,
			planModeVercelAiGatewayModelInfo: protoApiConfiguration.planModeVercelAiGatewayModelInfo
				? fromProtobufModelInfo(protoApiConfiguration.planModeVercelAiGatewayModelInfo)
				: undefined,
			planModeOcaModelInfo: protoApiConfiguration.planModeOcaModelInfo
				? fromProtobufOcaModelInfo(protoApiConfiguration.planModeOcaModelInfo)
				: undefined,
			planModeAihubmixModelInfo: protoApiConfiguration.planModeAihubmixModelInfo
				? fromProtobufOpenAiCompatibleModelInfo(protoApiConfiguration.planModeAihubmixModelInfo)
				: undefined,

			// Act Mode
			actModeOpenRouterModelInfo: protoApiConfiguration.actModeOpenRouterModelInfo
				? fromProtobufModelInfo(protoApiConfiguration.actModeOpenRouterModelInfo)
				: undefined,
			actModeClineModelInfo: protoApiConfiguration.actModeClineModelInfo
				? fromProtobufModelInfo(protoApiConfiguration.actModeClineModelInfo)
				: undefined,
			actModeClinePassModelInfo: protoApiConfiguration.actModeClinePassModelInfo
				? fromProtobufModelInfo(protoApiConfiguration.actModeClinePassModelInfo)
				: undefined,
			actModeOpenAiModelInfo: protoApiConfiguration.actModeOpenAiModelInfo
				? fromProtobufOpenAiCompatibleModelInfo(protoApiConfiguration.actModeOpenAiModelInfo)
				: undefined,
			actModeLiteLlmModelInfo: protoApiConfiguration.actModeLiteLlmModelInfo
				? fromProtobufLiteLLMModelInfo(protoApiConfiguration.actModeLiteLlmModelInfo)
				: undefined,
			actModeRequestyModelInfo: protoApiConfiguration.actModeRequestyModelInfo
				? fromProtobufModelInfo(protoApiConfiguration.actModeRequestyModelInfo)
				: undefined,
			actModeGroqModelInfo: protoApiConfiguration.actModeGroqModelInfo
				? fromProtobufModelInfo(protoApiConfiguration.actModeGroqModelInfo)
				: undefined,
			actModeHuggingFaceModelInfo: protoApiConfiguration.actModeHuggingFaceModelInfo
				? fromProtobufModelInfo(protoApiConfiguration.actModeHuggingFaceModelInfo)
				: undefined,
			actModeHuaweiCloudMaasModelInfo: protoApiConfiguration.actModeHuaweiCloudMaasModelInfo
				? fromProtobufModelInfo(protoApiConfiguration.actModeHuaweiCloudMaasModelInfo)
				: undefined,
			actModeBasetenModelInfo: protoApiConfiguration.actModeBasetenModelInfo
				? fromProtobufModelInfo(protoApiConfiguration.actModeBasetenModelInfo)
				: undefined,
			actModeVercelAiGatewayModelInfo: protoApiConfiguration.actModeVercelAiGatewayModelInfo
				? fromProtobufModelInfo(protoApiConfiguration.actModeVercelAiGatewayModelInfo)
				: undefined,
			actModeOcaModelInfo: protoApiConfiguration.actModeOcaModelInfo
				? fromProtobufOcaModelInfo(protoApiConfiguration.actModeOcaModelInfo)
				: undefined,
			actModeAihubmixModelInfo: protoApiConfiguration.actModeAihubmixModelInfo
				? fromProtobufOpenAiCompatibleModelInfo(protoApiConfiguration.actModeAihubmixModelInfo)
				: undefined,
			geminiPlanModeThinkingLevel: protoApiConfiguration.geminiPlanModeThinkingLevel,
			geminiActModeThinkingLevel: protoApiConfiguration.geminiActModeThinkingLevel,
			planModeReasoningEffort: protoApiConfiguration.planModeReasoningEffort as OpenaiReasoningEffort | undefined,
			actModeReasoningEffort: protoApiConfiguration.actModeReasoningEffort as OpenaiReasoningEffort | undefined,
		}

		const previousApiConfiguration = controller.stateManager.getApiConfiguration()
		const normalizedApiConfiguration = normalizeProviderSwitchModel(
			controller.getProviderConfigStore(),
			previousApiConfiguration,
			convertedApiConfigurationFromProto,
		)

		// Update the API configuration in storage
		controller.stateManager.setApiConfiguration(normalizedApiConfiguration)
		clearOrganizationForClinePassProviderSelection(controller, normalizedApiConfiguration)

		// Cline Cubed: the new model shim reaches EVERY live chat immediately — a settings
		// change is account-wide, not a fact about whichever chat is focused.
		{
			const currentMode = controller.stateManager.getGlobalSettingsKey("mode")
			const modelId = resolveActiveModelIdFromApiConfiguration(normalizedApiConfiguration, currentMode)
			controller.applyToLiveTasks((task) => {
				task.api = createTaskApiModelShim(modelId)
			})
		}
		controller.handleApiConfigurationChanged(previousApiConfiguration, normalizedApiConfiguration)

		// Post updated state to webview
		await controller.postStateToWebview()

		return Empty.create()
	} catch (error) {
		Logger.error(`Failed to update API configuration: ${error}`)
		throw error
	}
}
