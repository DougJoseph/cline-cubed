import { ApiConfiguration } from "@shared/api"
import { buildImageBridgeBlock } from "@shared/bridge/constants"
import { resolveActiveModelIdFromApiConfiguration } from "@/core/controller/models/taskApiModel"
import type { ProviderConfigStore } from "@/sdk/model-catalog/contracts"
import { parseProviderId } from "@/sdk/model-catalog/provider-id"
import { Logger } from "@/shared/services/Logger"
import { beginBridgeSubmission, recordBridgeDebug } from "./bridgeDebug"
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
	 * master `debugLoggingEnabled` setting.
	 */
	debugEnabled?: boolean
	/**
	 * Cline Cubed: the chat this submission belongs to, so the inline debug panel in ANOTHER chat
	 * never shows these lines. Absent when a new chat is being started — the id does not exist yet,
	 * and the caller names it afterwards.
	 */
	sessionId?: string
}

/** Shown when an image arrives and no model that can see images is set. */
export const IMAGE_CANNOT_BE_READ =
	"This image can't be read: the selected model can't see images and no Image Mode model is set. Choose one in Settings → API Configuration → Image Mode."

export interface ImageModeBridgeConfig {
	provider: string
	modelId: string
	apiKey?: string
	apiUri?: string
	apiFormat?: string
	reasoningEffort?: string
	maxTokens?: number
}

/**
 * The Image Mode model and its credentials, or undefined when no Image Mode model is set. The Image
 * tab writes provider-scoped credentials (e.g. `deepSeekApiKey`), so those are read from the provider
 * config store, falling back to the generic `imageModeApi*` slots.
 */
export function resolveImageModeBridge(
	apiConfiguration: ApiConfiguration,
	providerConfigStore?: ProviderConfigStore,
): ImageModeBridgeConfig | undefined {
	const modelId = resolveActiveModelIdFromApiConfiguration(apiConfiguration, "image")
	if (!modelId || modelId === "unknown") {
		return undefined
	}
	const provider = (apiConfiguration.imageModeApiProvider ?? "openai") as string
	let apiKey = apiConfiguration.imageModeApiKey
	let apiUri = apiConfiguration.imageModeApiUri
	// Cline Cubed: the Image Mode reasoning setting is sent whenever it is set, for any image model.
	const reasoningEffort: string | undefined = apiConfiguration.imageModeReasoningEffort
	let maxTokens: number | undefined
	if (providerConfigStore) {
		try {
			const effective = providerConfigStore.read(parseProviderId(provider))
			apiKey = apiKey ?? effective.apiKey
			apiUri = apiUri ?? effective.baseUrl
			const imageSelection = providerConfigStore.readSelection(parseProviderId(provider), "image")
			maxTokens = imageSelection?.modelInfo.maxTokens
		} catch (error) {
			Logger.warn("Image bridge credential resolution failed; using imageModeApi* slots:", error)
		}
	}
	return { provider, modelId, apiKey, apiUri, apiFormat: apiConfiguration.imageModeApiFormat, reasoningEffort, maxTokens }
}

/** Whether the active Plan/Act model can see images: "yes", "no", or "unknown" when it cannot be told. */
export function activeModelImageSupport(
	apiConfiguration: ApiConfiguration,
	providerConfigStore: ProviderConfigStore | undefined,
	mode: string | undefined,
): "yes" | "no" | "unknown" {
	const activeMode = mode === "plan" ? "plan" : "act"
	const provider = activeMode === "plan" ? apiConfiguration.planModeApiProvider : apiConfiguration.actModeApiProvider
	if (!provider || !providerConfigStore) {
		return "unknown"
	}
	try {
		const supports = providerConfigStore.readSelection(parseProviderId(provider), activeMode)?.modelInfo.supportsImages
		return supports === true ? "yes" : supports === false ? "no" : "unknown"
	} catch (error) {
		Logger.warn("Image capability check failed:", error)
		return "unknown"
	}
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
	const { text, images, apiConfiguration, providerConfigStore, mode, debugEnabled, sessionId } = input
	// Cline Cubed: every line recorded below belongs to THIS run, in THIS chat, so the panel under
	// the message this submission produces shows its own calls and no one else's.
	beginBridgeSubmission(sessionId)
	const debug = (line: string, failed?: boolean) => recordBridgeDebug(line, failed ?? false, debugEnabled ?? false)

	// No images to bridge, or no Image Mode model is configured — leave
	// everything untouched (the existing placeholder path handles the
	// unconfigured case).
	if (images.length === 0 || !apiConfiguration) {
		debug(`skipped: ${images.length === 0 ? "no images" : "no api configuration"}`)
		return { text, images, bridgedCount: 0 }
	}

	const imageMode = resolveImageModeBridge(apiConfiguration, providerConfigStore)
	const activeSupport = activeModelImageSupport(apiConfiguration, providerConfigStore, mode)
	if (!imageMode) {
		// No Image Mode model. A model known not to see images cannot read the image, so it is not
		// sent, and both the person and the model are told. An unknown capability keeps today's
		// behavior: the image goes to the model, which may be able to read it.
		if (activeSupport === "no") {
			debug(IMAGE_CANNOT_BE_READ, true)
			const count = images.length
			const note = `\n\n[${count === 1 ? "An image was" : `${count} images were`} attached but could not be read: no model that can see images is set.]`
			return { text: text + note, images: [], bridgedCount: 0 }
		}
		debug("skipped: no Image Mode model configured")
		return { text, images, bridgedCount: 0 }
	}

	// Capability gate: skip the bridge when the active Plan/Act model itself is
	// vision-capable — it should see the raw images, not the bridge's paraphrase.
	if (activeSupport === "yes") {
		debug(`skipped: active ${mode === "plan" ? "plan" : "act"} model is vision-capable`)
		return { text, images, bridgedCount: 0 }
	}

	const { provider, modelId: imageModeModelId, apiKey, apiUri, apiFormat, reasoningEffort, maxTokens } = imageMode

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
				maxTokens,
				recordDebug: debug,
			})
			descriptions.push(description)
			bridgedCount++
		} catch (error) {
			// A failed bridge must not silently drop the image's existence from
			// the reasoner's context — surface the failure inline.
			//
			// It is recorded through the same channel as every other outcome, because the failure
			// is the case the inline panel exists for: a run that records only its successes
			// leaves the panel with nothing to show at the one moment someone is looking. The
			// `failed` flag also sends it to the output channel whether or not debug logging is
			// on, so this reaches the log as well without a second call.
			const reason = error instanceof Error ? error.message : String(error)
			debug(`failed: ${reason}`, true)
			descriptions.push(`[Image bridge failed: ${reason}]`)
			bridgedCount++
		}
	}

	if (bridgedCount === 0) {
		return { text, images, bridgedCount: 0 }
	}

	const bridgeBlock = buildImageBridgeBlock(descriptions)
	return { text: text + bridgeBlock, images: [], bridgedCount }
}
