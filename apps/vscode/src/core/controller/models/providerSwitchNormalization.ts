import { MODEL_COLLECTIONS_BY_PROVIDER_ID } from "@cline/llms"
import type { Mode, ProviderConfigStore, ProviderId } from "@/sdk/model-catalog/contracts"
import { parseProviderId } from "@/sdk/model-catalog/provider-id"
import { toSdkProviderId } from "@/sdk/model-catalog/sdk-provider-id"
import { providerCatalogListsModel } from "@/sdk/model-catalog/stored-mode-model"
import type { ApiConfiguration, ApiProvider } from "@/shared/api"
import { getProviderModelIdKey } from "@/shared/storage/provider-keys"

type ProviderSwitchConfig = Partial<
	Pick<
		ApiConfiguration,
		| "planModeApiProvider"
		| "actModeApiProvider"
		| "imageModeApiProvider"
		| "planModeApiModelId"
		| "actModeApiModelId"
		| "imageModeApiModelId"
		| "imageModeApiModelInfo"
	>
>

const modeFields = {
	plan: {
		provider: "planModeApiProvider",
		modelId: "planModeApiModelId",
	},
	act: {
		provider: "actModeApiProvider",
		modelId: "actModeApiModelId",
	},
	image: {
		provider: "imageModeApiProvider",
		modelId: "imageModeApiModelId",
	},
} as const

const switchableModes = ["plan", "act", "image"] as const

function toProviderId(provider: ApiProvider | string | undefined): ProviderId | undefined {
	const trimmed = provider?.trim()
	return trimmed ? parseProviderId(trimmed) : undefined
}

function resolveProviderSwitchModelId(
	store: ProviderConfigStore,
	providerId: ProviderId,
	mode: Mode,
	currentModelId: string | undefined,
): string | undefined {
	// providers.json holds one model per provider, so it can only speak for
	// Plan and Act. Image Mode never inherits it.
	if (mode !== "image") {
		const ownModelId = store.readSelection(providerId, mode)?.modelId
		if (ownModelId) {
			return ownModelId
		}
	}
	return currentModelId && providerCatalogListsModel(providerId, currentModelId) ? currentModelId : undefined
}

/**
 * Keep shared model-id slots truthful when a mode changes provider: the slot
 * takes the new provider's own last model, or is cleared. It never receives a
 * catalog default, and never keeps a model that belongs to the previous provider.
 */
export function normalizeProviderSwitchModel<T extends ProviderSwitchConfig>(
	store: ProviderConfigStore,
	previous: ProviderSwitchConfig,
	next: T,
): T {
	const normalized: ProviderSwitchConfig = { ...next }

	for (const mode of switchableModes) {
		const fields = modeFields[mode]
		const previousProvider = previous[fields.provider]
		const nextProvider = (normalized[fields.provider] ?? previousProvider) as ApiProvider | undefined
		if (!nextProvider || nextProvider === previousProvider) {
			continue
		}

		const providerId = toProviderId(nextProvider)
		if (!providerId) {
			continue
		}

		// Providers with their own model-id field keep it; only the shared slot
		// can carry a value left by a different provider.
		if (getProviderModelIdKey(nextProvider, mode) !== fields.modelId) {
			continue
		}

		// A custom provider has no catalog to judge the value against.
		if (!MODEL_COLLECTIONS_BY_PROVIDER_ID[toSdkProviderId(providerId)]) {
			continue
		}

		const incomingModelId = normalized[fields.modelId]
		if (incomingModelId && incomingModelId !== previous[fields.modelId]) {
			continue
		}

		const currentModelId = (incomingModelId ?? previous[fields.modelId]) as string | undefined
		const resolvedModelId = resolveProviderSwitchModelId(store, providerId, mode, currentModelId)
		normalized[fields.modelId] = resolvedModelId
		if (mode === "image" && resolvedModelId !== previous.imageModeApiModelId) {
			normalized.imageModeApiModelInfo = undefined
		}
	}

	return normalized as T
}
