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
import { extractImageDescriptions, IMAGE_DESCRIPTION_RULE } from "./image-description-marker"
import {
	CARRIED_IMAGE_DESCRIPTION_PROMPT,
	chooseDescriberOrder,
	type DescribeResult,
	type EarlierImagesMode,
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

/**
 * Cline Cubed: whether the main model writes the chat's image descriptions inside its own reply:
 * earlier images go as descriptions, and the describer the user's order picks first is the main model.
 */
export function mainModelDescribesInReply(input: {
	earlierImages: EarlierImagesMode
	order: ImageDescriberOrder
	imageModeSet: boolean
	mainModelSeesImages: "yes" | "no" | "unknown"
}): boolean {
	if (input.earlierImages !== "descriptions") {
		return false
	}
	const order = chooseDescriberOrder(input.order, {
		imageMode: input.imageModeSet,
		mainModel: input.mainModelSeesImages === "yes",
	})
	return order[0] === "mainModel"
}

/** Whether the main model describes the chat's pictures in its reply, from the current settings. */
export function describesInReplyNow(stateManager: StateManager, providerConfigStore?: ProviderConfigStore): boolean {
	return mainModelDescribesInReply({
		earlierImages: stateManager.getGlobalSettingsKey("earlierImages") ?? "pictures",
		order: stateManager.getGlobalSettingsKey("imageDescriber") ?? "imageModeFirst",
		imageModeSet: resolveImageModeBridge(stateManager.getApiConfiguration(), providerConfigStore) !== undefined,
		mainModelSeesImages: activeModelImageSupport(
			stateManager.getApiConfiguration(),
			providerConfigStore,
			currentMode(stateManager),
		),
	})
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

/**
 * The separate describing request to the main model, now used only for an image that cannot go to
 * it as a picture (over the limits). Cline Cubed: it follows the main model's own reasoning setting.
 */
async function describeWithMainModel(stateManager: StateManager, image: ImageBlock): Promise<string> {
	const handler = buildApiHandler(stateManager.getApiConfiguration(), currentMode(stateManager))
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

	const describesInReply = (): boolean => describesInReplyNow(stateManager, providerConfigStore)

	return {
		name: "cline-image-descriptions",
		manifest: { capabilities: ["messageBuilders", "tools", "hooks", "rules"] },
		hooks: {
			afterRun: async ({ result }) => {
				// Cline Cubed: the descriptions the main model wrote in its reply are saved first.
				if (describesInReply()) {
					const found = extractImageDescriptions(result.outputText ?? "")
					if (found.size > 0) {
						const name =
							resolveActiveModelIdFromApiConfiguration(
								stateManager.getApiConfiguration(),
								currentMode(stateManager),
							) ?? "unknown"
						descriptions?.applyReplyDescriptions(found, `the main model (${name})`)
					}
				}
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
				describesInReply,
				notify: (text) => options.emitNotice(text, sessionId),
			})
			descriptions = current
			// The system prompt is rebuilt on every message, so a change of describer applies from the next one.
			api.registerRule({
				id: "cline-image-descriptions:rule",
				source: "image-descriptions",
				content: () => (describesInReply() ? IMAGE_DESCRIPTION_RULE : ""),
			})
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
