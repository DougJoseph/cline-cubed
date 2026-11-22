import { type ModelInfo, openAiModelInfoSafeDefaults } from "@shared/api"
import type { ProviderConfigResponse } from "@shared/proto/cline/models"
import { fromProtobufModelInfo } from "@shared/proto-conversions/models/typeConversion"
import type { Mode } from "@shared/storage/types"
import { useCallback } from "react"
import type { ProviderId } from "@/context/ExtensionStateContext"
import type { ProviderModelSelection } from "./useProviderConfig"

type ProviderModelSelectionInput =
	| (Omit<ProviderModelSelection, "providerId"> & { modelInfo?: ModelInfo })
	| (ProviderModelSelection & { modelInfo?: ModelInfo })

interface DisplayProviderModelSelection extends ProviderModelSelection {
	modelInfo: ModelInfo
}

interface UseProviderModelSelectionOptions {
	models: Record<string, ModelInfo>
	defaultModelId?: string
	config?: ProviderConfigResponse
	commitSelection: (mode: Mode, selection: ProviderModelSelection) => Promise<unknown>
	fallbackModelInfo?: ModelInfo
	customModelInfo?: (modelId: string) => ModelInfo
}

export function useProviderModelSelection(
	providerId: ProviderId,
	currentMode: Mode,
	{
		models,
		defaultModelId,
		config,
		commitSelection,
		fallbackModelInfo = openAiModelInfoSafeDefaults,
		customModelInfo,
	}: UseProviderModelSelectionOptions,
) {
	const committedSelection =
		currentMode === "plan" ? config?.planSelection : currentMode === "image" ? config?.imageSelection : config?.actSelection
	const fallbackModelId = defaultModelId || Object.keys(models)[0] || ""
	const selectedModelId = committedSelection?.modelId ?? fallbackModelId
	const selectedModelInfo = committedSelection?.modelInfo
		? fromProtobufModelInfo(committedSelection.modelInfo)
		: (models[selectedModelId] ??
			(selectedModelId && customModelInfo ? customModelInfo(selectedModelId) : undefined) ??
			fallbackModelInfo)

	const selectedModel: DisplayProviderModelSelection = {
		providerId,
		modelId: selectedModelId,
		modelInfo: selectedModelInfo,
	}

	const commitModelSelection = useCallback(
		(selection: ProviderModelSelectionInput) => {
			// A selection that names no model must not reach the host: the host writes
			// the incoming id over the stored selection, so a blank id erases the
			// model the user chose. Attribute the edit to the model on screen.
			const modelId = selection.modelId?.trim() || selectedModelId
			if (!modelId) {
				return Promise.reject(new Error(`commitSelection for ${providerId} requires a model id`))
			}
			return commitSelection(currentMode, {
				providerId,
				modelId,
				...(selection.overrides !== undefined ? { overrides: selection.overrides } : {}),
			})
		},
		[commitSelection, currentMode, providerId, selectedModelId],
	)

	return {
		committedSelection,
		fallbackModelId,
		selectedModel,
		selectedModelId,
		selectedModelInfo,
		commitModelSelection,
	}
}
