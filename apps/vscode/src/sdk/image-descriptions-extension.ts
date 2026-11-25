import { join } from "node:path"
import type { CoreSessionConfig } from "@cline/core"
import { createTool } from "@cline/shared"
import { resolveSessionDataDir } from "@cline/shared/storage"
import type { Mode } from "@shared/storage/types"
import { bridgeImage } from "@/core/bridge/imageBridge"
import { activeModelImageSupport, resolveImageModeBridge } from "@/core/bridge/interceptImages"
import { resolveActiveModelIdFromApiConfiguration } from "@/core/controller/models/taskApiModel"
import type { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"
import {
	CARRIED_IMAGE_DESCRIPTION_PROMPT,
	chooseDescriberOrder,
	type DescribeResult,
	type ImageDescriberOrder,
	ImageDescriptions,
	imageLimitsFromMegabytes,
} from "./image-descriptions"
import type { ProviderConfigStore } from "./model-catalog/contracts"
import { buildApiHandler } from "./sdk-api-handler"

interface ImageBlock {
	type: "image"
	data: string
	mediaType: string
}

export interface ImageDescriberDeps {
	order: () => ImageDescriberOrder
	/** The Image Mode model, or undefined when none is set. */
	imageMode: () => { provider: string; modelId: string } | undefined
	mainModelSeesImages: () => "yes" | "no" | "unknown"
	mainModelName: () => string
	describeWithImageMode: (image: ImageBlock) => Promise<string>
	describeWithMainModel: (image: ImageBlock) => Promise<string>
}

/**
 * Describes one image with the user's first choice of model, falling back to the other when the
 * first is not set, cannot see images, or fails. Answers undefined when no model can.
 */
export function createImageDescriber(deps: ImageDescriberDeps): (image: ImageBlock) => Promise<DescribeResult | undefined> {
	return async (image) => {
		const imageMode = deps.imageMode()
		const order = chooseDescriberOrder(deps.order(), {
			imageMode: imageMode !== undefined,
			mainModel: deps.mainModelSeesImages() === "yes",
		})
		for (const describer of order) {
			try {
				if (describer === "imageMode" && imageMode) {
					const description = await deps.describeWithImageMode(image)
					return { description, describedBy: `the Image Mode model (${imageMode.modelId})` }
				}
				if (describer === "mainModel") {
					const description = await deps.describeWithMainModel(image)
					return { description, describedBy: `the main model (${deps.mainModelName()})` }
				}
			} catch (error) {
				Logger.error(
					`Image description by ${describer === "imageMode" ? "the Image Mode model" : "the main model"} failed:`,
					error,
				)
			}
		}
		return undefined
	}
}

export interface ImageDescriptionsExtensionOptions {
	stateManager: StateManager
	providerConfigStore?: ProviderConfigStore
	/** Shows a notice in one chat. */
	emitNotice: (text: string, sessionId: string | undefined) => void
}

function currentMode(stateManager: StateManager): Mode {
	return stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"
}

async function describeWithMainModel(stateManager: StateManager, image: ImageBlock): Promise<string> {
	const handler = buildApiHandler(stateManager.getApiConfiguration(), currentMode(stateManager), { disableReasoning: true })
	let answer = ""
	let failure: string | undefined
	for await (const chunk of handler.createMessage(CARRIED_IMAGE_DESCRIPTION_PROMPT, [
		{ role: "user", content: [image, { type: "text", text: "Describe this image." }] },
	])) {
		if (chunk.type === "text") {
			answer += chunk.text
		} else if (chunk.type === "done" && chunk.success === false) {
			failure = chunk.error
		}
	}
	if (failure) {
		throw new Error(failure)
	}
	if (!answer.trim()) {
		throw new Error("The main model returned no description.")
	}
	return answer.trim()
}

/**
 * Cline Cubed: the session extension that decides how each image goes to the model, as a picture
 * or as its saved description (`image-descriptions.ts`), offers `view_earlier_image`, and, with
 * earlier images sent as descriptions, describes a turn's images in the background when the turn ends.
 */
export function createImageDescriptionsExtension(
	options: ImageDescriptionsExtensionOptions,
): NonNullable<CoreSessionConfig["extensions"]>[number] {
	const { stateManager, providerConfigStore } = options
	let descriptions: ImageDescriptions | undefined

	const describe = createImageDescriber({
		order: () => stateManager.getGlobalSettingsKey("imageDescriber") ?? "imageModeFirst",
		imageMode: () => resolveImageModeBridge(stateManager.getApiConfiguration(), providerConfigStore),
		mainModelSeesImages: () =>
			activeModelImageSupport(stateManager.getApiConfiguration(), providerConfigStore, currentMode(stateManager)),
		mainModelName: () =>
			resolveActiveModelIdFromApiConfiguration(stateManager.getApiConfiguration(), currentMode(stateManager)) ?? "unknown",
		describeWithImageMode: async (image) => {
			const imageMode = resolveImageModeBridge(stateManager.getApiConfiguration(), providerConfigStore)
			if (!imageMode) {
				throw new Error("No Image Mode model is set.")
			}
			return bridgeImage({
				base64: image.data,
				mediaType: image.mediaType,
				...imageMode,
				prompt: CARRIED_IMAGE_DESCRIPTION_PROMPT,
			})
		},
		describeWithMainModel: (image) => describeWithMainModel(stateManager, image),
	})

	return {
		name: "cline-image-descriptions",
		manifest: { capabilities: ["messageBuilders", "tools", "hooks"] },
		hooks: {
			afterRun: async () => {
				// Started, not awaited: the next message should not wait for the describing.
				void descriptions?.describePending()
			},
		},
		setup(api, context) {
			const sessionId = context.session?.sessionId
			const current = new ImageDescriptions({
				filePath: sessionId
					? join(resolveSessionDataDir(), sessionId, `${sessionId}.image-descriptions.json`)
					: undefined,
				limits: () =>
					imageLimitsFromMegabytes({
						total: stateManager.getGlobalSettingsKey("imagesTotalLimitMb") ?? 8,
						perImageEncoded: stateManager.getGlobalSettingsKey("imagesPerImageLimitMb") ?? 5,
						perImageDecoded: stateManager.getGlobalSettingsKey("imagesPerImageDecodedLimitMb") ?? 6,
					}),
				earlierImages: () => stateManager.getGlobalSettingsKey("earlierImages") ?? "pictures",
				describe,
				notify: (text) => options.emitNotice(text, sessionId),
			})
			descriptions = current
			api.registerMessageBuilder({
				name: "cline-image-descriptions",
				build: (messages) => current.buildRequest(messages),
			})
			api.registerTool(
				createTool<unknown, unknown>({
					name: "view_earlier_image",
					description:
						"Show an image from an earlier message of this chat again, as a picture. An image sent as a text description names its image_id; use this when you need a detail the description does not give.",
					inputSchema: {
						type: "object",
						properties: { image_id: { type: "integer", description: "The image's id, from its description." } },
						required: ["image_id"],
					},
					execute: async (input) => current.viewEarlierImage(Number((input as { image_id?: unknown }).image_id)),
				}),
			)
		},
	}
}
