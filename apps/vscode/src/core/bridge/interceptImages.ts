import { ApiConfiguration } from "@shared/api"
import { buildImageBridgeBlock } from "@shared/bridge/constants"
import { Logger } from "@/shared/services/Logger"
import { bridgeImage } from "./imageBridge"

const DATA_URL_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/

export interface ImageInterceptionInput {
	text: string
	images: string[]
	apiConfiguration: ApiConfiguration | undefined
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
 * v1 contract: configuring Image Mode IS the bridge signal. A future increment
 * can add model-capability inference (bridge only when the active model is
 * non-vision) by gating the call here.
 */
export async function interceptImagesForNonVisionModel(input: ImageInterceptionInput): Promise<ImageInterceptionResult> {
	const { text, images, apiConfiguration } = input

	// No images to bridge, or no Image Mode model is configured — leave
	// everything untouched (the existing placeholder path handles the
	// unconfigured case).
	if (images.length === 0 || !apiConfiguration?.imageModeApiModelId) {
		return { text, images, bridgedCount: 0 }
	}

	const provider = (apiConfiguration.imageModeApiProvider ?? "openai") as string
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
				modelId: apiConfiguration.imageModeApiModelId,
				apiKey: apiConfiguration.imageModeApiKey,
				apiUri: apiConfiguration.imageModeApiUri,
				apiFormat: apiConfiguration.imageModeApiFormat,
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
