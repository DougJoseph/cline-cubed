import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message } from "@cline/shared"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	chooseDescriberOrder,
	type DescribeResult,
	type EarlierImagesMode,
	ImageDescriptions,
	type ImageLimits,
	imageLimitsFromMegabytes,
} from "./image-descriptions"

let root: string
let file: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "image-descriptions-"))
	file = join(root, "chat.image-descriptions.json")
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

/** A base64 string of exactly `length` characters. */
function data(length: number, fill = "A"): string {
	return fill.repeat(length)
}

function image(payload: string) {
	return { type: "image" as const, data: payload, mediaType: "image/png" }
}

function prompt(text: string, ...payloads: string[]): Message {
	return { role: "user", content: [{ type: "text", text }, ...payloads.map(image)] }
}

function reply(text: string): Message {
	return { role: "assistant", content: [{ type: "text", text }] }
}

function toolResult(...payloads: string[]): Message {
	return {
		role: "user",
		content: [
			{
				type: "tool_result",
				tool_use_id: "t1",
				name: "read_file",
				content: [{ type: "text", text: "read" }, ...payloads.map(image)],
			},
		],
	}
}

function imagesIn(messages: Message[]): string[] {
	const found: string[] = []
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue
		for (const block of message.content) {
			if (block.type === "image") found.push(block.data)
			if (block.type === "tool_result" && Array.isArray(block.content)) {
				for (const entry of block.content) {
					if (entry.type === "image") found.push(entry.data)
				}
			}
		}
	}
	return found
}

function textIn(messages: Message[]): string {
	return JSON.stringify(messages)
}

const roomy: ImageLimits = { maxTotalBytes: 1_000, maxImageEncodedBytes: 1_000, maxImageDecodedBytes: 1_000 }

function setup(
	options: {
		limits?: ImageLimits
		describe?: (payload: string) => DescribeResult | undefined
		earlierImages?: EarlierImagesMode
	} = {},
) {
	const calls: string[] = []
	const notices: string[] = []
	const descriptions = new ImageDescriptions({
		filePath: file,
		limits: () => options.limits ?? roomy,
		earlierImages: () => options.earlierImages ?? "descriptions",
		describe: async (img) => {
			calls.push(img.data)
			return options.describe
				? options.describe(img.data)
				: { description: `about ${img.data.slice(0, 3)}`, describedBy: "test model" }
		},
		notify: (text) => notices.push(text),
	})
	return { descriptions, calls, notices }
}

describe("ImageDescriptions.buildRequest", () => {
	it("sends the current prompt's images raw and earlier images as their descriptions", async () => {
		const old = data(40, "B")
		const fresh = data(40, "C")
		const { descriptions } = setup()
		const messages = [prompt("first", old), reply("seen"), prompt("second", fresh)]

		const out = await descriptions.buildRequest(messages)

		expect(imagesIn(out)).toEqual([fresh])
		expect(textIn(out)).toContain("about BBB")
		expect(textIn(out)).toContain("view_earlier_image")
	})

	it("never changes the messages it is given", async () => {
		const old = data(40, "B")
		const { descriptions } = setup()
		const messages = [prompt("first", old), reply("seen"), prompt("second")]
		const before = JSON.stringify(messages)

		await descriptions.buildRequest(messages)

		expect(JSON.stringify(messages)).toBe(before)
	})

	it("describes an image once, saves it, and reuses the saved description after a reload", async () => {
		const old = data(40, "B")
		const messages = [prompt("first", old), reply("seen"), prompt("second")]
		const first = setup()
		await first.descriptions.buildRequest(messages)
		await first.descriptions.buildRequest(messages)
		expect(first.calls).toHaveLength(1)
		expect(existsSync(file)).toBe(true)

		const afterReload = setup()
		const out = await afterReload.descriptions.buildRequest(messages)

		expect(afterReload.calls).toHaveLength(0)
		expect(textIn(out)).toContain("about BBB")
	})

	it("rewrites a description saved by the long Image Mode prompt once, as a short one", async () => {
		const old = data(40, "B")
		const hash = createHash("sha256").update(old).digest("hex")
		writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				nextId: 2,
				images: { [hash]: { id: 1, description: "LONG OLD DESCRIPTION", describedBy: "x", mediaType: "image/png" } },
			}),
		)
		const messages = [prompt("first", old), reply("seen"), prompt("second")]
		const { descriptions, calls } = setup()

		const out = await descriptions.buildRequest(messages)
		await descriptions.buildRequest(messages)

		expect(calls).toHaveLength(1)
		expect(textIn(out)).toContain("about BBB")
		expect(textIn(out)).not.toContain("LONG OLD DESCRIPTION")
		const saved = JSON.parse(readFileSync(file, "utf8")) as { images: Record<string, { style?: string }> }
		expect(saved.images[hash].style).toBe("short")
	})

	it("describes the same image pasted twice only once, under one id", async () => {
		const same = data(40, "B")
		const { descriptions, calls } = setup()
		const out = await descriptions.buildRequest([
			prompt("first", same),
			reply("seen"),
			prompt("again", same),
			reply("seen again"),
			prompt("third"),
		])

		expect(calls).toHaveLength(1)
		expect(textIn(out).match(/\[Image 1\b/g)).toHaveLength(2)
	})

	it("sends earlier tool-returned images as descriptions and this turn's tool images raw", async () => {
		const earlierShot = data(40, "D")
		const thisTurnShot = data(40, "E")
		const { descriptions } = setup()
		const out = await descriptions.buildRequest([
			prompt("look"),
			toolResult(earlierShot),
			reply("done"),
			prompt("look again"),
			toolResult(thisTurnShot),
		])

		expect(imagesIn(out)).toEqual([thisTurnShot])
		expect(textIn(out)).toContain("about DDD")
	})

	it("sends this message's images past the total limit as descriptions, and says so once", async () => {
		const a = data(40, "F")
		const b = data(40, "G")
		const c = data(40, "H")
		const { descriptions, notices } = setup({
			limits: { maxTotalBytes: 90, maxImageEncodedBytes: 1_000, maxImageDecodedBytes: 1_000 },
		})
		const messages = [prompt("three", a, b, c)]

		const out = await descriptions.buildRequest(messages)
		await descriptions.buildRequest(messages)

		expect(imagesIn(out)).toEqual([a, b])
		expect(textIn(out)).toContain("about HHH")
		expect(notices).toHaveLength(1)
		expect(notices[0]).toContain("1 image was sent as a description")
	})

	it("lets an image a tool returns this turn in as a picture even when the prompt's images fill the total", async () => {
		const old = data(40, "B")
		const a = data(40, "F")
		const b = data(40, "G")
		const { descriptions } = setup({
			limits: { maxTotalBytes: 90, maxImageEncodedBytes: 1_000, maxImageDecodedBytes: 1_000 },
		})

		const out = await descriptions.buildRequest([
			prompt("first", old),
			reply("seen"),
			prompt("two more", a, b),
			toolResult(old),
		])

		expect(imagesIn(out)).toEqual([a, old])
		expect(textIn(out)).toContain("about GGG")
	})

	it("says an image pushed out by this message's other images was pushed out by them", async () => {
		const a = data(40, "F")
		const b = data(40, "G")
		const c = data(40, "H")
		const { descriptions, notices } = setup({
			limits: { maxTotalBytes: 90, maxImageEncodedBytes: 1_000, maxImageDecodedBytes: 1_000 },
		})

		const out = await descriptions.buildRequest([prompt("three", a, b, c)])

		expect(textIn(out)).toContain("sent as a description because this message's other images filled the")
		expect(notices[0]).toContain("because this message's other images filled the")
		expect(textIn(out)).not.toContain("exceeds this message's image limits")
	})

	it("says images pushed out by a tool's images later in the turn were pushed out by them", async () => {
		const a = data(40, "F")
		const b = data(40, "G")
		const x = data(40, "X")
		const y = data(40, "Y")
		const { descriptions, notices } = setup({
			limits: { maxTotalBytes: 90, maxImageEncodedBytes: 1_000, maxImageDecodedBytes: 1_000 },
		})

		const out = await descriptions.buildRequest([prompt("two", a, b), toolResult(x, y)])

		expect(imagesIn(out)).toEqual([x, y])
		expect(
			textIn(out).match(/sent as a description because images a tool returned later in this turn filled the/g),
		).toHaveLength(2)
		expect(notices).toHaveLength(1)
		expect(notices[0]).toContain(
			"2 images were sent as descriptions for this request, because 2 images a tool returned later in this turn, such as ones the model asked to see again, filled the",
		)
		expect(notices[0]).not.toContain("exceed the image limits")
	})

	it("says an image over the per-image limit is over it", async () => {
		const big = data(200, "J")
		const { descriptions, notices } = setup({
			limits: { maxTotalBytes: 1_000, maxImageEncodedBytes: 100, maxImageDecodedBytes: 1_000 },
		})

		const out = await descriptions.buildRequest([prompt("one", big)])

		expect(textIn(out)).toContain("sent as a description because it is over the")
		expect(textIn(out)).toContain("per-image limit")
		expect(notices[0]).toContain("1 image was sent as a description for this request, because it is over the")
	})

	it("labels an earlier image as seen before and only a description in this request", async () => {
		const old = data(40, "B")
		const { descriptions } = setup()

		const out = await descriptions.buildRequest([prompt("first", old), reply("seen"), prompt("second")])

		expect(textIn(out)).toContain(
			"[Image 1 (seen as a picture in an earlier request; this request has only this description), described by",
		)
		expect(textIn(out)).not.toContain("(sent earlier)")
	})

	it("tells the model a description can be wrong and how to see the image", async () => {
		const old = data(40, "B")
		const { descriptions } = setup()

		const out = await descriptions.buildRequest([prompt("first", old), reply("seen"), prompt("second")])

		expect(textIn(out)).toContain(
			"A description can miss or misstate details. To see this image itself, call view_earlier_image with image_id 1.",
		)
	})

	it("sends an image over the per-image limit as a description", async () => {
		const big = data(200, "J")
		const small = data(40, "K")
		const { descriptions } = setup({
			limits: { maxTotalBytes: 1_000, maxImageEncodedBytes: 100, maxImageDecodedBytes: 1_000 },
		})

		const out = await descriptions.buildRequest([prompt("two", big, small)])

		expect(imagesIn(out)).toEqual([small])
		expect(textIn(out)).toContain("about JJJ")
	})

	it("says plainly when no model could describe an earlier image", async () => {
		const old = data(40, "B")
		const { descriptions } = setup({ describe: () => undefined })

		const out = await descriptions.buildRequest([prompt("first", old), reply("seen"), prompt("second")])

		expect(imagesIn(out)).toEqual([])
		expect(textIn(out)).toContain("could not be described")
	})

	it("puts each picture's image number directly before it, and leaves a tool's pictures to the tool's own text", async () => {
		const old = data(40, "B")
		const b = data(40, "C")
		const c = data(40, "D")
		const shot = data(40, "E")
		const { descriptions } = setup()

		const out = await descriptions.buildRequest([
			prompt("first", old),
			reply("seen"),
			prompt("second", b, c),
			toolResult(shot),
		])

		const promptContent = out[2].content as Array<{ type: string; text?: string; data?: string }>
		expect(promptContent.map((block) => block.text ?? block.data)).toEqual(["second", "Image 2:", b, "Image 3:", c])
		const toolContent = (out[3].content as Array<{ content: Array<{ type: string; text?: string; data?: string }> }>)[0]
			.content
		expect(toolContent.map((entry) => entry.text ?? entry.data)).toEqual(["read", shot])
	})

	it("after a view_earlier_image result, says what the tool returned in a way a later description does not contradict", async () => {
		const old = data(40, "B")
		const first = setup()
		await first.descriptions.buildRequest([prompt("first", old), reply("seen"), prompt("show it")])
		const toolOutput = first.descriptions.viewEarlierImage(1)
		const viewed: Message = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "v1", name: "view_earlier_image", content: toolOutput }],
		} as Message

		const out = await first.descriptions.buildRequest([
			prompt("first", old),
			reply("seen"),
			prompt("show it"),
			viewed,
			reply("looked"),
			prompt("how many now?"),
		])

		expect(imagesIn(out)).toEqual([])
		expect(textIn(out)).toContain(
			'Image 1, returned by view_earlier_image:"},{"type":"text","text":"[Image 1 (seen as a picture in an earlier request; this request has only this description)',
		)
		expect(textIn(out)).not.toContain("as it was sent:")
	})
})

describe("ImageDescriptions.buildRequest with earlier images sent as pictures", () => {
	it("sends earlier images as pictures, numbered, and describes none of them", async () => {
		const old = data(40, "B")
		const earlierShot = data(40, "D")
		const { descriptions, calls } = setup({ earlierImages: "pictures" })

		const out = await descriptions.buildRequest([
			prompt("first", old),
			toolResult(earlierShot),
			reply("seen"),
			prompt("second"),
		])

		expect(imagesIn(out)).toEqual([old, earlierShot])
		expect(textIn(out)).toContain('"Image 1:"')
		expect(textIn(out)).not.toContain("seen as a picture in an earlier request")
		expect(calls).toHaveLength(0)
	})

	it("keeps the newest pictures within the total and sends the oldest as descriptions, saying why", async () => {
		const oldest = data(40, "B")
		const older = data(40, "C")
		const newest = data(40, "D")
		const { descriptions, notices } = setup({
			earlierImages: "pictures",
			limits: { maxTotalBytes: 90, maxImageEncodedBytes: 1_000, maxImageDecodedBytes: 1_000 },
		})

		const out = await descriptions.buildRequest([
			prompt("first", oldest),
			reply("seen"),
			prompt("second", older),
			reply("seen"),
			prompt("third", newest),
		])

		expect(imagesIn(out)).toEqual([older, newest])
		expect(textIn(out)).toContain("[Image 1 (sent as a description because newer images filled the")
		expect(textIn(out)).toContain("about BBB")
		expect(notices).toHaveLength(1)
		expect(notices[0]).toContain("1 image was sent as a description for this request, because newer images filled the")
	})

	it("does not describe images in the background after a turn", async () => {
		const fresh = data(40, "C")
		const { descriptions, calls } = setup({ earlierImages: "pictures" })
		await descriptions.buildRequest([prompt("look", fresh)])

		await descriptions.describePending()

		expect(calls).toHaveLength(0)
	})
})

describe("ImageDescriptions background describing", () => {
	it("describes the images sent raw this turn once the turn ends", async () => {
		const fresh = data(40, "C")
		const { descriptions, calls } = setup()
		await descriptions.buildRequest([prompt("look", fresh)])
		expect(calls).toHaveLength(0)

		await descriptions.describePending()

		expect(calls).toEqual([fresh])
		const saved = JSON.parse(readFileSync(file, "utf8")) as { images: Record<string, { description?: string }> }
		expect(Object.values(saved.images).map((entry) => entry.description)).toEqual(["about CCC"])
	})
})

describe("ImageDescriptions.viewEarlierImage", () => {
	it("returns an earlier image raw by its id", async () => {
		const old = data(40, "B")
		const { descriptions } = setup()
		await descriptions.buildRequest([prompt("first", old), reply("seen"), prompt("second")])

		const result = descriptions.viewEarlierImage(1)

		expect(result).toEqual([
			{ type: "text", text: "Image 1, returned by view_earlier_image:" },
			{ type: "image", data: old, mediaType: "image/png" },
		])
	})

	it("refuses an unknown id and an image over the per-image limit, with the reason", async () => {
		const big = data(200, "J")
		const { descriptions } = setup({
			limits: { maxTotalBytes: 1_000, maxImageEncodedBytes: 100, maxImageDecodedBytes: 1_000 },
		})
		await descriptions.buildRequest([prompt("first", big), reply("seen"), prompt("second")])

		expect(() => descriptions.viewEarlierImage(9)).toThrow("No earlier image has id 9")
		expect(() => descriptions.viewEarlierImage(1)).toThrow("over the per-image limit")
	})
})

describe("chooseDescriberOrder", () => {
	it("tries Image Mode first by default, then the main model", () => {
		expect(chooseDescriberOrder("imageModeFirst", { imageMode: true, mainModel: true })).toEqual(["imageMode", "mainModel"])
	})

	it("tries the main model first when chosen", () => {
		expect(chooseDescriberOrder("mainModelFirst", { imageMode: true, mainModel: true })).toEqual(["mainModel", "imageMode"])
	})

	it("falls back to whichever is available", () => {
		expect(chooseDescriberOrder("imageModeFirst", { imageMode: false, mainModel: true })).toEqual(["mainModel"])
		expect(chooseDescriberOrder("mainModelFirst", { imageMode: true, mainModel: false })).toEqual(["imageMode"])
		expect(chooseDescriberOrder("imageModeFirst", { imageMode: false, mainModel: false })).toEqual([])
	})
})

describe("imageLimitsFromMegabytes", () => {
	it("converts the Settings values to bytes", () => {
		expect(imageLimitsFromMegabytes({ total: 8, perImageEncoded: 5, perImageDecoded: 6 })).toEqual({
			maxTotalBytes: 8 * 1024 * 1024,
			maxImageEncodedBytes: 5 * 1024 * 1024,
			maxImageDecodedBytes: 6 * 1024 * 1024,
		})
	})
})
