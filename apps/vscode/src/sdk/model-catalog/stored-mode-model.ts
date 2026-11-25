import { getGeneratedModelsForProvider, MODEL_COLLECTIONS_BY_PROVIDER_ID } from "@cline/llms"
import type { ApiConfiguration } from "@shared/api"
import { getProviderModelIdKey } from "@shared/storage/provider-keys"
import type { Mode } from "@shared/storage/types"
import { stringifyVsCodeLmModelSelector } from "@shared/vsCodeSelectorUtils"
import { getProviderSettingsManager } from "../provider-migration"
import { toSdkProviderId } from "./sdk-provider-id"

/**
 * The SDK cannot start a session with an empty model, and an old chat must still
 * open when the current mode has none. A session holding this id exists but can
 * never send: every send stops at the session lifecycle's send funnel.
 */
export const NO_MODEL_SELECTED_ID = "no-model-selected"

/** A send was stopped because its mode has no model. Its message is written for the chat. */
export class MissingModelError extends Error {
	constructor(modeLabel: string) {
		super(`No model is selected for ${modeLabel} Mode. Select one in Settings → API Configuration.`)
		this.name = "MissingModelError"
	}
}

function storedText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function catalogListsModel(sdkProviderId: string, modelId: string): boolean {
	return Boolean(
		getGeneratedModelsForProvider(sdkProviderId)[modelId] ||
			MODEL_COLLECTIONS_BY_PROVIDER_ID[sdkProviderId]?.models?.[modelId],
	)
}

function readProviderWideModelId(sdkProviderId: string): string | undefined {
	try {
		return storedText(getProviderSettingsManager().getProviderSettings(sdkProviderId as never)?.model)
	} catch {
		return undefined
	}
}

/** Whether this provider's own catalog lists the model. */
export function providerCatalogListsModel(provider: string, modelId: string): boolean {
	return catalogListsModel(toSdkProviderId(provider), modelId)
}

/**
 * True only when a shared-slot value is provably another provider's model. An id
 * that no catalog lists stays, because it may be a custom model typed by hand.
 */
export function modelBelongsToAnotherProvider(provider: string, modelId: string, rememberedModelId?: string): boolean {
	const sdkProviderId = toSdkProviderId(provider)
	if (
		modelId === rememberedModelId ||
		catalogListsModel(sdkProviderId, modelId) ||
		modelId === readProviderWideModelId(sdkProviderId)
	) {
		return false
	}
	return Object.keys(MODEL_COLLECTIONS_BY_PROVIDER_ID).some((id) => id !== sdkProviderId && catalogListsModel(id, modelId))
}

/** Dify runs whatever model its application is configured with. */
export function providerModelIsSetByProvider(provider: string): boolean {
	return toSdkProviderId(provider) === "dify"
}

/** Ollama and LM Studio run their provider-wide model when a mode has none. */
export function providerHasLocalModelSource(provider: string): boolean {
	return Boolean(MODEL_COLLECTIONS_BY_PROVIDER_ID[toSdkProviderId(provider)]?.provider.modelsSourceUrl)
}

/**
 * The model stored for this provider and mode. Settings and the runtime both
 * read it here, so what is displayed is what is sent.
 */
export function readStoredModeModelId(
	config: ApiConfiguration,
	provider: string,
	mode: Mode,
	rememberedModelId?: string,
): string | undefined {
	if (provider === "vscode-lm" && mode !== "image") {
		const selector = mode === "plan" ? config.planModeVsCodeLmModelSelector : config.actModeVsCodeLmModelSelector
		return selector ? stringifyVsCodeLmModelSelector(selector) || undefined : undefined
	}

	const sharedKey = mode === "plan" ? "planModeApiModelId" : mode === "act" ? "actModeApiModelId" : "imageModeApiModelId"
	const providerKey = getProviderModelIdKey(provider, mode) as keyof ApiConfiguration
	if (providerKey !== sharedKey) {
		const ownValue = storedText(config[providerKey])
		if (ownValue || provider !== "sapaicore") {
			return ownValue
		}
	}

	const sharedValue = storedText(config[sharedKey])
	return sharedValue && !modelBelongsToAnotherProvider(provider, sharedValue, rememberedModelId) ? sharedValue : undefined
}
