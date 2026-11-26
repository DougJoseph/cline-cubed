import { connectionChangesFromWrite } from "@/sdk/provider-connection-update"
import { ProviderConfigResponse, WriteProviderConfigRequest } from "@/shared/proto/cline/models"
import {
	type ProviderCatalogController,
	parseProviderIdRequest,
	toProviderConfigPatch,
	toRedactedProviderConfigResponse,
} from "./providerCatalogShared"

export async function writeProviderConfig(
	controller: ProviderCatalogController,
	request: WriteProviderConfigRequest,
): Promise<ProviderConfigResponse> {
	const providerId = parseProviderIdRequest(request.providerId)
	const store = controller.getProviderConfigStore()
	const updated = store.write(providerId, toProviderConfigPatch(request.patch))
	// Cline Cubed: a saved Base URL, key, or headers reaches the chats already open on this
	// provider; without it an open chat kept its old address until the window was reloaded.
	const changes = connectionChangesFromWrite(request.patch, updated)
	if (changes && controller.applyProviderConnectionChange) {
		await controller.applyProviderConnectionChange(providerId, changes)
	}
	return toRedactedProviderConfigResponse(updated, store)
}
