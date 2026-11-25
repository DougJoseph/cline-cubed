import type { ApiConfiguration, ModelInfo } from "@shared/api"
import { fromProtobufModelInfo } from "@shared/proto-conversions/models/typeConversion"
import type { Mode } from "@shared/storage/types"
import { useMemo } from "react"
import type { ProviderId } from "@/context/ExtensionStateContext"
import { useProviderConfig } from "./useProviderConfig"
import { useProviderModels } from "./useProviderModels"
import { useProviderUsageCostDisplay } from "./useProviderUsageCostDisplay"

export interface StaticProviderSelectionOptions {
	/**
	 * Optional saved model id override. When provided, the hook reads
	 * selection from this value instead of the common
	 * `{plan,act}ModeApiModelId` field. Used by providers that maintain
	 * a provider-specific saved id field (e.g. `planModeFireworksModelId`).
	 */
	savedModelId?: string
}

/**
 * Shared selection logic for provider components whose:
 *   - model list is driven by the SDK via gRPC (`useProviderModels`).
 *   - model id is stored in `{plan,act}ModeApiModelId` by default, or in
 *     a provider-specific field passed via `savedModelId` option.
 *
 * A saved id this provider's catalog lists is shown directly. Any other id is
 * shown only if the host confirms it as this mode's committed selection, which
 * excludes a value left in the shared slot by a different provider. With neither,
 * the selection is empty: a catalog default is never displayed as chosen.
 *
 * `hideUsageCost` is sourced from the SDK's
 * `ProviderListing.usage_cost_display` (see `useProviderUsageCostDisplay`),
 * so consumers must pass the returned value through to
 * `<ModelInfoView hideUsageCost={...} />` instead of hard-coding any
 * per-provider knowledge.
 */
export function useStaticProviderSelection(
	providerId: string,
	apiConfiguration: ApiConfiguration | undefined,
	currentMode: Mode,
	options: StaticProviderSelectionOptions = {},
): {
	models: Record<string, ModelInfo>
	defaultModelId: string
	selectedModelId: string
	selectedModelInfo: ModelInfo
	hideUsageCost: boolean
} {
	const { models, defaultModelId } = useProviderModels(providerId)
	const hideUsageCost = useProviderUsageCostDisplay(providerId) === "hide"

	const { config } = useProviderConfig(providerId as ProviderId)
	const committedSelection =
		currentMode === "plan" ? config?.planSelection : currentMode === "image" ? config?.imageSelection : config?.actSelection
	const fallbackSavedModelId =
		currentMode === "plan"
			? apiConfiguration?.planModeApiModelId
			: currentMode === "image"
				? apiConfiguration?.imageModeApiModelId
				: apiConfiguration?.actModeApiModelId
	const savedModelId = options.savedModelId ?? fallbackSavedModelId

	const { selectedModelId, selectedModelInfo } = useMemo((): { selectedModelId: string; selectedModelInfo: ModelInfo } => {
		if (savedModelId && models[savedModelId]) {
			return { selectedModelId: savedModelId, selectedModelInfo: models[savedModelId] }
		}
		if (committedSelection?.modelId) {
			return {
				selectedModelId: committedSelection.modelId,
				selectedModelInfo:
					models[committedSelection.modelId] ??
					(committedSelection.modelInfo
						? fromProtobufModelInfo(committedSelection.modelInfo)
						: { supportsPromptCache: false }),
			}
		}
		return { selectedModelId: "", selectedModelInfo: { supportsPromptCache: false } }
	}, [savedModelId, committedSelection, models])

	return { models, defaultModelId, selectedModelId, selectedModelInfo, hideUsageCost }
}
