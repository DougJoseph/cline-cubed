import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Message } from "@cline/shared"
import { Logger } from "@/shared/services/Logger"

/**
 * Cline Cubed: decides how each image in a chat goes to the model. With earlier images sent as
 * pictures (the default), every image goes as a picture while the request's images fit the limits,
 * newest kept first, and only the rest go as saved text descriptions; a server that reuses unchanged
 * images across turns then re-reads nothing. With earlier images sent as descriptions, an image goes
 * raw once, in the message it came with, and every later request carries its description instead.
 * The saved chat keeps every original image; only the outgoing request is changed. Descriptions are
 * cached per chat in a file beside the chat, keyed by the image's content, so a reload reuses them
 * and the same image is described once.
 */

/** The Settings defaults, in megabytes as they are shown. */
export const DEFAULT_IMAGE_LIMITS_MB = { total: 8, perImageEncoded: 5, perImageDecoded: 6 } as const

export type ImageDescriberOrder = "imageModeFirst" | "mainModelFirst"
/** How images from before the current turn are sent: as pictures, or as their saved descriptions. */
export type EarlierImagesMode = "pictures" | "descriptions"
export type ImageDescriber = "imageMode" | "mainModel"

export interface ImageLimits {
	maxTotalBytes: number
	maxImageEncodedBytes: number
	maxImageDecodedBytes: number
}

export interface DescribeResult {
	description: string
	describedBy: string
}

interface ImageBlock {
	type: "image"
	data: string
	mediaType: string
}

interface CacheEntry {
	id: number
	description?: string
	describedBy?: string
	mediaType: string
	/** "short" when written with CARRIED_IMAGE_DESCRIPTION_PROMPT; absent for the long Image Mode prompt. */
	style?: "short"
}

/**
 * The prompt for a description that is carried with every later message in place of its image.
 * Kept short because it is re-sent each time; the model can see the image itself again with
 * `view_earlier_image`. Image Mode's own prompt, for a model that cannot see, stays exhaustive.
 */
export const CARRIED_IMAGE_DESCRIPTION_PROMPT = `Describe this image in about 150 words, for an AI assistant that saw it earlier in a conversation and is now given this description instead of the image.

Say what the image is (for example a screenshot of a named application, a photo, a diagram) and what it shows. Quote any text that matters to understanding it, such as titles, headings, messages, errors, and key numbers, but do not transcribe everything. Do not guess at what is not visible.

Output only the description.`

interface CacheFile {
	version: 1
	nextId: number
	images: Record<string, CacheEntry>
}

const MEGABYTE = 1024 * 1024

export function imageLimitsFromMegabytes(mb: { total: number; perImageEncoded: number; perImageDecoded: number }): ImageLimits {
	return {
		maxTotalBytes: Math.round(mb.total * MEGABYTE),
		maxImageEncodedBytes: Math.round(mb.perImageEncoded * MEGABYTE),
		maxImageDecodedBytes: Math.round(mb.perImageDecoded * MEGABYTE),
	}
}

/** The describers to try, in order, given the user's choice and which ones can see images. */
export function chooseDescriberOrder(
	order: ImageDescriberOrder,
	available: { imageMode: boolean; mainModel: boolean },
): ImageDescriber[] {
	const preferred: ImageDescriber[] = order === "mainModelFirst" ? ["mainModel", "imageMode"] : ["imageMode", "mainModel"]
	return preferred.filter((describer) => available[describer])
}

function hashImage(data: string): string {
	return createHash("sha256").update(data).digest("hex")
}

function decodedBytes(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
	return Math.floor((data.length * 3) / 4) - padding
}

function formatMegabytes(bytes: number): string {
	const mb = bytes / MEGABYTE
	return Number.isInteger(mb) ? String(mb) : mb.toFixed(1)
}

/** Why an image that would otherwise go as a picture was sent as its description instead. */
type OverflowReason = "overPerImage" | "overPerImageDecoded" | "laterToolImages" | "sameMessage" | "newerImages" | "unclassified"

interface RawChoice {
	/** The images sent as pictures: this turn's within the limits, and earlier ones too when they go as pictures. */
	raw: Set<ImageBlock>
	reasons: Map<ImageBlock, OverflowReason>
	/** How many images in messages after the prompt (the images tools returned) went as pictures. */
	laterToolImages: number
}

function overflowLabel(reason: OverflowReason, limits: ImageLimits): string {
	switch (reason) {
		case "overPerImage":
			return `sent as a description because it is over the ${formatMegabytes(limits.maxImageEncodedBytes)} MB per-image limit`
		case "overPerImageDecoded":
			return `sent as a description because it is over the ${formatMegabytes(limits.maxImageDecodedBytes)} MB decoded per-image limit`
		case "laterToolImages":
			return `sent as a description because images a tool returned later in this turn filled the ${formatMegabytes(limits.maxTotalBytes)} MB image limit for this request`
		case "sameMessage":
			return `sent as a description because this message's other images filled the ${formatMegabytes(limits.maxTotalBytes)} MB image limit`
		case "newerImages":
			return `sent as a description because newer images filled the ${formatMegabytes(limits.maxTotalBytes)} MB image limit for this request`
		case "unclassified":
			return "sent as a description for a reason that was not recorded"
	}
}

function overflowNotice(
	overflow: Array<{ hash: string; reason: OverflowReason }>,
	laterToolImages: number,
	limits: ImageLimits,
): string {
	const subject = (count: number) =>
		count === 1
			? "1 image was sent as a description for this request"
			: `${count} images were sent as descriptions for this request`
	const total = formatMegabytes(limits.maxTotalBytes)
	const sentences: string[] = []
	const perImage = overflow.filter((item) => item.reason === "overPerImage" || item.reason === "overPerImageDecoded").length
	const later = overflow.filter((item) => item.reason === "laterToolImages").length
	const same = overflow.filter((item) => item.reason === "sameMessage").length
	if (perImage > 0) {
		sentences.push(
			`${subject(perImage)}, because ${perImage === 1 ? "it is" : "they are"} over the ${formatMegabytes(limits.maxImageEncodedBytes)} MB per-image limit (${formatMegabytes(limits.maxImageDecodedBytes)} MB decoded).`,
		)
	}
	if (later > 0) {
		const tools = laterToolImages === 1 ? "1 image a tool returned" : `${laterToolImages} images a tool returned`
		sentences.push(
			`${subject(later)}, because ${tools} later in this turn, such as ones the model asked to see again, filled the ${total} MB image limit.`,
		)
	}
	if (same > 0) {
		sentences.push(`${subject(same)}, because this message's other images filled the ${total} MB image limit.`)
	}
	const newer = overflow.filter((item) => item.reason === "newerImages").length
	if (newer > 0) {
		sentences.push(`${subject(newer)}, because newer images filled the ${total} MB image limit.`)
	}
	const unclassified = overflow.filter((item) => item.reason === "unclassified").length
	if (unclassified > 0) {
		sentences.push(`${subject(unclassified)}, for a reason that was not recorded.`)
	}
	sentences.push("The limits are in Settings → Features → Images sent to the model.")
	return sentences.join(" ")
}

/** The index of the user prompt that started the current turn: the last user message holding no tool results. */
function currentPromptIndex(messages: Message[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (message.role !== "user") continue
		if (!Array.isArray(message.content) || !message.content.some((block) => block.type === "tool_result")) {
			return index
		}
	}
	return -1
}

export interface ImageDescriptionsOptions {
	/** The cache file for this chat. Absent: descriptions are kept in memory only. */
	filePath?: string
	/** The user's limits, read on every request so a change applies to the next message. */
	limits: () => ImageLimits
	/** The user's choice for images from before the current turn, read on every request. */
	earlierImages: () => EarlierImagesMode
	/** Describes one image, or answers undefined when no model that can see images is available. */
	describe: (image: ImageBlock) => Promise<DescribeResult | undefined>
	/** Shows a notice in this chat. */
	notify: (text: string) => void
}

export class ImageDescriptions {
	private readonly cache: CacheFile
	private readonly imagesByHash = new Map<string, ImageBlock>()
	private readonly inFlight = new Map<string, Promise<void>>()
	private readonly sentRawThisTurn = new Set<string>()
	private readonly notified = new Set<string>()

	constructor(private readonly options: ImageDescriptionsOptions) {
		this.cache = this.load()
	}

	/**
	 * The request to send: the images that go as pictures, each after its image number, and every
	 * other image as its description. The messages passed in are never changed.
	 */
	async buildRequest(messages: Message[]): Promise<Message[]> {
		const limits = this.options.limits()
		const earlierAsPictures = this.options.earlierImages() === "pictures"
		const promptIndex = currentPromptIndex(messages)
		// Numbers every image in the order it appears, so ids follow the chat's order.
		for (const image of this.allImages(messages)) {
			const hash = hashImage(image.data)
			this.imagesByHash.set(hash, image)
			this.entryFor(hash, image.mediaType)
		}
		const overflow: Array<{ hash: string; reason: OverflowReason }> = []
		this.sentRawThisTurn.clear()
		const rawThisTurn = this.chooseRaw(messages, promptIndex, limits, earlierAsPictures)
		// Describe every image that goes as a description and still lacks one at once, rather than one by one below.
		const toDescribe = earlierAsPictures
			? [...rawThisTurn.reasons.keys()]
			: [...this.earlierImages(messages, promptIndex), ...rawThisTurn.reasons.keys()]
		await Promise.all(toDescribe.map((image) => this.ensureDescribed(hashImage(image.data))))

		const out: Message[] = []
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index]
			if (!Array.isArray(message.content)) {
				out.push(message)
				continue
			}
			const currentTurn = promptIndex >= 0 && index >= promptIndex
			const content = []
			for (const block of message.content) {
				if (block.type === "image") {
					content.push(...(await this.place(block, currentTurn, rawThisTurn, overflow, true)))
				} else if (block.type === "tool_result" && Array.isArray(block.content)) {
					const entries = []
					for (const entry of block.content) {
						if (entry.type === "image") {
							entries.push(...(await this.place(entry, currentTurn, rawThisTurn, overflow, false)))
						} else {
							entries.push(entry)
						}
					}
					content.push({ ...block, content: entries })
				} else {
					content.push(block)
				}
			}
			out.push({ ...message, content } as Message)
		}

		if (overflow.length > 0) {
			const key = overflow.map((item) => `${item.hash}:${item.reason}`).join(",")
			if (!this.notified.has(key)) {
				this.notified.add(key)
				this.options.notify(overflowNotice(overflow, rawThisTurn.laterToolImages, limits))
			}
		}
		return out
	}

	/**
	 * Describes, in the background, the images this turn sent raw, so the next message does not wait.
	 * With earlier images sent as pictures it does nothing: an image is described only when it first
	 * has to go as a description.
	 */
	async describePending(): Promise<void> {
		if (this.options.earlierImages() === "pictures") {
			return
		}
		const pending = [...this.sentRawThisTurn]
		await Promise.all(pending.map((hash) => this.ensureDescribed(hash)))
	}

	/** The `view_earlier_image` tool's result: an earlier image, raw, by its id. */
	viewEarlierImage(id: number): Array<{ type: "text"; text: string } | ImageBlock> {
		const hash = Object.keys(this.cache.images).find((key) => this.cache.images[key].id === id)
		const image = hash ? this.imagesByHash.get(hash) : undefined
		if (!hash || !image) {
			throw new Error(`No earlier image has id ${id} in this chat.`)
		}
		const limits = this.options.limits()
		if (image.data.length > limits.maxImageEncodedBytes || decodedBytes(image.data) > limits.maxImageDecodedBytes) {
			throw new Error(
				`Image ${id} is over the per-image limit (${formatMegabytes(limits.maxImageEncodedBytes)} MB), so it can only be sent as its description.`,
			)
		}
		// True whether the picture follows, or, in a later request, its description: "as it was sent"
		// before a description led a model to decide the tool had returned only text.
		return [{ type: "text", text: `Image ${id}, returned by view_earlier_image:` }, image]
	}

	private allImages(messages: Message[]): ImageBlock[] {
		return this.earlierImages(messages, messages.length)
	}

	private earlierImages(messages: Message[], promptIndex: number): ImageBlock[] {
		const end = promptIndex >= 0 ? promptIndex : messages.length
		const found: ImageBlock[] = []
		for (const message of messages.slice(0, end)) {
			if (!Array.isArray(message.content)) continue
			for (const block of message.content) {
				if (block.type === "image") found.push(block)
				if (block.type === "tool_result" && Array.isArray(block.content)) {
					for (const entry of block.content) {
						if (entry.type === "image") found.push(entry)
					}
				}
			}
		}
		return found
	}

	/**
	 * Decides which images go raw: the current turn's, and with `earlierAsPictures` the earlier ones
	 * too. Later messages are placed first, so an image a tool returns (such as one the model asked
	 * for with `view_earlier_image`) gets in even when the prompt's images fill the total, and the
	 * oldest images are the ones left out; within one message, images keep their order.
	 * Each image left out is given the reason it was left out.
	 */
	private chooseRaw(messages: Message[], promptIndex: number, limits: ImageLimits, earlierAsPictures: boolean): RawChoice {
		const raw = new Set<ImageBlock>()
		const reasons = new Map<ImageBlock, OverflowReason>()
		let laterToolImages = 0
		if (promptIndex < 0) return { raw, reasons, laterToolImages }
		let used = 0
		const firstIndex = earlierAsPictures ? 0 : promptIndex
		for (let index = messages.length - 1; index >= firstIndex; index--) {
			const message = messages[index]
			if (!Array.isArray(message.content)) continue
			const images: ImageBlock[] = []
			for (const block of message.content) {
				if (block.type === "image") images.push(block)
				if (block.type === "tool_result" && Array.isArray(block.content)) {
					for (const entry of block.content) {
						if (entry.type === "image") images.push(entry)
					}
				}
			}
			const usedByLaterMessages = used
			for (const image of images) {
				const size = image.data.length
				if (size > limits.maxImageEncodedBytes) {
					reasons.set(image, "overPerImage")
				} else if (decodedBytes(image.data) > limits.maxImageDecodedBytes) {
					reasons.set(image, "overPerImageDecoded")
				} else if (used + size > limits.maxTotalBytes) {
					reasons.set(
						image,
						index < promptIndex ? "newerImages" : usedByLaterMessages > 0 ? "laterToolImages" : "sameMessage",
					)
				} else {
					used += size
					raw.add(image)
					if (index > promptIndex) laterToolImages++
				}
			}
		}
		return { raw, reasons, laterToolImages }
	}

	private async place(
		image: ImageBlock,
		currentTurn: boolean,
		rawThisTurn: RawChoice,
		overflow: Array<{ hash: string; reason: OverflowReason }>,
		numbered: boolean,
	): Promise<Array<{ type: "text"; text: string } | ImageBlock>> {
		const hash = hashImage(image.data)
		this.imagesByHash.set(hash, image)
		const entry = this.entryFor(hash, image.mediaType)

		if (rawThisTurn.raw.has(image)) {
			if (currentTurn) {
				this.sentRawThisTurn.add(hash)
			}
			// A picture a tool returned keeps the tool's own text; any other picture is preceded by its
			// number, so a model never has to number the pictures by counting them.
			return numbered ? [{ type: "text", text: `Image ${entry.id}:` }, image] : [image]
		}

		if (currentTurn || rawThisTurn.reasons.has(image)) {
			let reason = rawThisTurn.reasons.get(image)
			if (!reason) {
				Logger.error(`[image-descriptions] Image ${entry.id} was left out of this request with no recorded reason.`)
				reason = "unclassified"
			}
			overflow.push({ hash, reason })
			await this.ensureDescribed(hash)
			return [{ type: "text", text: this.describedText(entry, overflowLabel(reason, this.options.limits())) }]
		}

		await this.ensureDescribed(hash)
		// Says what this request holds, not only when the image was sent: "sent earlier" let a model
		// count an earlier picture as one it has now.
		const how = entry.description
			? "seen as a picture in an earlier request; this request has only this description"
			: "seen as a picture in an earlier request"
		return [{ type: "text", text: this.describedText(entry, how) }]
	}

	private describedText(entry: CacheEntry, how: string): string {
		if (!entry.description) {
			return `[Image ${entry.id} (${how}): it could not be described because no model that can see images is available.]`
		}
		return `[Image ${entry.id} (${how}), described by ${entry.describedBy}: ${entry.description}\nA description can miss or misstate details. To see this image itself, call view_earlier_image with image_id ${entry.id}.]`
	}

	private entryFor(hash: string, mediaType: string): CacheEntry {
		let entry = this.cache.images[hash]
		if (!entry) {
			entry = { id: this.cache.nextId++, mediaType }
			this.cache.images[hash] = entry
			this.save()
		}
		return entry
	}

	private ensureDescribed(hash: string): Promise<void> {
		const entry = this.cache.images[hash]
		// A description from the long Image Mode prompt (no style) is rewritten short once.
		if (entry?.description && entry.style === "short") {
			return Promise.resolve()
		}
		const running = this.inFlight.get(hash)
		if (running) {
			return running
		}
		const image = this.imagesByHash.get(hash)
		if (!entry || !image) {
			return Promise.resolve()
		}
		const work = (async () => {
			try {
				const result = await this.options.describe(image)
				if (result) {
					entry.description = result.description
					entry.describedBy = result.describedBy
					entry.style = "short"
					this.save()
				}
			} catch (error) {
				Logger.error(`Image description failed for image ${entry.id}:`, error)
			} finally {
				this.inFlight.delete(hash)
			}
		})()
		this.inFlight.set(hash, work)
		return work
	}

	private load(): CacheFile {
		const empty: CacheFile = { version: 1, nextId: 1, images: {} }
		if (!this.options.filePath) {
			return empty
		}
		try {
			const parsed = JSON.parse(readFileSync(this.options.filePath, "utf8")) as CacheFile
			if (parsed?.version === 1 && parsed.images && typeof parsed.nextId === "number") {
				return parsed
			}
			Logger.error(`Image descriptions file has an unknown format and was not used: ${this.options.filePath}`)
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				Logger.error(`Image descriptions file could not be read: ${this.options.filePath}`, error)
			}
		}
		return empty
	}

	private save(): void {
		if (!this.options.filePath) {
			return
		}
		try {
			mkdirSync(dirname(this.options.filePath), { recursive: true })
			writeFileSync(this.options.filePath, `${JSON.stringify(this.cache, null, 2)}\n`, "utf8")
		} catch (error) {
			Logger.error(`Image descriptions file could not be saved: ${this.options.filePath}`, error)
		}
	}
}
