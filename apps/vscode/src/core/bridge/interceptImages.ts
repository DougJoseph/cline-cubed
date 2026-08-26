import { ApiConfiguration } from "@shared/api"
import { buildImageBridgeBlock } from "@shared/bridge/constants"
import { resolveActiveModelIdFromApiConfiguration } from "@/core/controller/models/taskApiModel"
import type { ProviderConfigStore } from "@/sdk/model-catalog/contracts"
import { parseProviderId } from "@/sdk/model-catalog/provider-id"
import { Logger } from "@/shared/services/Logger"
import { recordBridgeDebug } from "./bridgeDebug"
import { bridgeImage } from "./imageBridge"

const DATA_URL_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/

export interface ImageInterceptionInput {
	text: string
	images: string[]
	apiConfiguration: ApiConfiguration | undefined
	/**
	 * The provider config store, used to (a) resolve the Image Mode provider's
	 * API key/base URL (the Image tab writes provider-scoped creds, not the
	 * generic `imageModeApi*` slots) and (b) gate the bridge on the active
	 * Plan/Act model's vision capability.
	 */
	providerConfigStore?: ProviderConfigStore
	/** The active chat mode ("plan" | "act"). Image never reaches the runtime. */
	mode?: string
	/**
	 * Cline Cubed: when true the bridge debug lines are also written to the VS
	 * Code output channel (the in-memory buffer records regardless, so inline
	 * display works without the toggle). Sourced from the
	 * `imageBridgeDebugEnabled` setting.
	 */
	debugEnabled?: boolean
}

export interface ImageInterceptionResult {
	text: string
	images: string[]
	bridgedCount: number
}

/**
 * Cline Cubed interception: when a user message carries images and an Image
 * Mode model is configured, run the image bridge and replace the raw images
 * with the vision model's text description — so a text-only reasoning model
 * gets the image's full content. The request then carries no image bytes.
 *
 * Capability gate: the bridge only runs when the ACTIVE Plan/Act model is
 * non-vision (supportsImages !== true). A vision-capable active model receives
 * the raw images, preserving its native image understanding. A missing/unknown
 * capability is treated as non-vision so the bridge still helps (the fork's
 * text-only-reasoner + vision-bridge value proposition).
 */
export async function interceptImagesForNonVisionModel(input: ImageInterceptionInput): Promise<ImageInterceptionResult> {
	const { text, images, apiConfiguration, providerConfigStore, mode, debugEnabled } = input
	const debug = (line: string, failed?: boolean) => recordBridgeDebug(line, failed ?? false, debugEnabled ?? false)

	// No images to bridge, or no Image Mode model is configured — leave
	// everything untouched (the existing placeholder path handles the
	// unconfigured case).
	if (images.length === 0 || !apiConfiguration) {
		debug(`skipped: ${images.length === 0 ? "no images" : "no api configuration"}`)
		return { text, images, bridgedCount: 0 }
	}

	const imageModeModelId = resolveActiveModelIdFromApiConfiguration(apiConfiguration, "image")
	if (!imageModeModelId || imageModeModelId === "unknown") {
		debug("skipped: no Image Mode model configured")
		return { text, images, bridgedCount: 0 }
	}

	// Capability gate: skip the bridge when the active Plan/Act model itself is
	// vision-capable — it should see the raw images, not the bridge's paraphrase.
	const activeMode = mode === "plan" || mode === "act" ? mode : "act"
	const activeProvider = (activeMode === "plan" ? apiConfiguration.planModeApiProvider : apiConfiguration.actModeApiProvider) as
		| string
		| undefined
	if (activeProvider && providerConfigStore) {
		try {
			const activeSelection = providerConfigStore.readSelection(parseProviderId(activeProvider), activeMode)
			if (activeSelection && activeSelection.modelInfo.supportsImages === true) {
				debug(`skipped: active ${activeMode} model ${activeSelection.modelId} is vision-capable`)
				return { text, images, bridgedCount: 0 }
			}
		} catch (error) {
			Logger.warn("Image bridge capability-gate resolution failed; bridging anyway:", error)
		}
	}

	const provider = (apiConfiguration.imageModeApiProvider ?? "openai") as string

	// Resolve Image Mode credentials. The Image tab writes provider-scoped
	// creds (e.g. `deepSeekApiKey`), so prefer those from the provider config
	// store, falling back to the generic `imageModeApi*` slots for backward
	// compat. Without this the bridge fires with no Authorization header.
	let apiKey = apiConfiguration.imageModeApiKey
	let apiUri = apiConfiguration.imageModeApiUri
	const apiFormat = apiConfiguration.imageModeApiFormat
	// Forward the Image tab's reasoning effort only when the image model is
	// KNOWN to support reasoning (catalog metadata); unknown/custom models get
	// no reasoning param so the request is never rejected for it.
	let reasoningEffort: string | undefined
	if (providerConfigStore) {
		try {
			const effective = providerConfigStore.read(parseProviderId(provider))
			apiKey = apiKey ?? effective.apiKey
			apiUri = apiUri ?? effective.baseUrl
			const imageSelection = providerConfigStore.readSelection(parseProviderId(provider), "image")
			if (imageSelection?.modelInfo.supportsReasoning === true) {
				reasoningEffort = apiConfiguration.imageModeReasoningEffort
			}
		} catch (error) {
			Logger.warn("Image bridge credential resolution failed; using imageModeApi* slots:", error)
		}
	}

	const descriptions: string[] = []
	let bridgedCount = 0

	for (const dataUrl of images) {
		const match = DATA_URL_RE.exec(dataUrl)
		if (!match) {
			continue
		}
		try {
			const description = await bridgeImage({
				base64: match[2],
				mediaType: match[1],
				provider,
				modelId: imageModeModelId,
				apiKey,
				apiUri,
				apiFormat,
				reasoningEffort,
				recordDebug: debug,
			})
			descriptions.push(description)
			bridgedCount++
		} catch (error) {
			// A failed bridge must not silently drop the image's existence from
			// the reasoner's context — surface the failure inline.
			Logger.error("Image bridge failed:", error)
			descriptions.push(`[Image bridge failed: ${error instanceof Error ? error.message : String(error)}]`)
			bridgedCount++
		}
	}

	if (bridgedCount === 0) {
		return { text, images, bridgedCount: 0 }
	}

	const bridgeBlock = buildImageBridgeBlock(descriptions)
	return { text: text + bridgeBlock, images: [], bridgedCount }
}
