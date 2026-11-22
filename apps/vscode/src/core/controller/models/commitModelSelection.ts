import { toLegacyApiProvider } from "@/shared/model-catalog/provider-helpers"
import { Empty } from "@/shared/proto/cline/common"
import { CommitModelSelectionRequest } from "@/shared/proto/cline/models"
import { Logger } from "@/shared/services/Logger"
import { getProviderModelIdKey } from "@/shared/storage/provider-keys"
import {
	hasProviderCatalogStateController,
	type ProviderCatalogController,
	parseModeRequest,
	parseProviderIdRequest,
	toModelSelection,
} from "./providerCatalogShared"

export async function commitModelSelection(
	controller: ProviderCatalogController,
	request: CommitModelSelectionRequest,
): Promise<Empty> {
	const providerId = parseProviderIdRequest(request.providerId)
	const mode = parseModeRequest(request.mode)
	const selection = toModelSelection(request, providerId)
	const modelId = selection.modelId?.trim() ?? ""
	if (!modelId) {
		// A commit that names no model would overwrite the stored selection with
		// nothing - the mode's model id and providers.json both take the incoming
		// id. Refuse it; the user's selection stays as it is.
		Logger.error(`Ignored a model selection commit for provider ${request.providerId} (${mode}) with no model id.`)
		return Empty.create()
	}
	const previousApiConfiguration = hasProviderCatalogStateController(controller)
		? controller.stateManager.getApiConfiguration?.()
		: undefined
	const cachedModels = controller.getProviderCatalog().peekModels(providerId)
	const baseModelInfoHint = cachedModels?.ok ? cachedModels.models.get(modelId) : undefined
	if (baseModelInfoHint) {
		controller.getProviderConfigStore().commitSelection(providerId, mode, { ...selection, modelId }, baseModelInfoHint)
	} else {
		controller.getProviderConfigStore().commitSelection(providerId, mode, { ...selection, modelId })
	}

	if (hasProviderCatalogStateController(controller)) {
		controller.stateManager.setGlobalStateBatch({
			[`${mode}ModeApiProvider`]: toLegacyApiProvider(providerId.toString()),
			[getProviderModelIdKey(toLegacyApiProvider(providerId.toString()), mode)]: modelId,
		})
		await controller.stateManager.flushPendingState?.()
		const nextApiConfiguration = controller.stateManager.getApiConfiguration?.()
		if (nextApiConfiguration) {
			controller.handleApiConfigurationChanged?.(previousApiConfiguration ?? {}, nextApiConfiguration)
		}
		// A model-only commit changes state the chat view renders (the model
		// label under the input reads `apiConfiguration` from pushed state),
		// so push the updated state instead of waiting for an unrelated
		// action (e.g. sending a message) to refresh it.
		await controller.postStateToWebview?.()
	}

	return Empty.create()
}
