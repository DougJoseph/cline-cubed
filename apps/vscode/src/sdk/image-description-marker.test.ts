import { describe, expect, it } from "vitest"
import {
	extractImageDescriptions,
	IMAGE_DESCRIPTION_REMINDER,
	IMAGE_DESCRIPTION_RULE,
	stripImageDescriptionLines,
	stripImageDescriptionReminder,
	withImageDescriptionReminder,
} from "./image-description-marker"

// Cline Cubed: when the main model describes images, it writes each description inside its own
// reply, on a line of its own, and the line is never shown in the chat.
describe("image description lines in the main model's reply", () => {
	const reply = [
		"The screenshot shows the Settings page.",
		"",
		'<image_description id="3">A screenshot of the Settings page, with the Features tab open.</image_description>',
		'<image_description id="4">A photo of a desk with two monitors.</image_description>',
	].join("\n")

	it("reads each description by its image number", () => {
		expect(extractImageDescriptions(reply)).toEqual(
			new Map([
				[3, "A screenshot of the Settings page, with the Features tab open."],
				[4, "A photo of a desk with two monitors."],
			]),
		)
	})

	it("ignores a tag written inside a sentence, and an empty description", () => {
		const text =
			'I will write <image_description id="5">x</image_description> later.\n<image_description id="6"> </image_description>'
		expect(extractImageDescriptions(text).size).toBe(0)
	})

	it("removes every description line from the reply as shown", () => {
		expect(stripImageDescriptionLines(reply)).toBe("The screenshot shows the Settings page.")
	})

	it("removes a last line still arriving, and a last line holding only the tag's first characters", () => {
		expect(stripImageDescriptionLines('Done.\n<image_description id="3">A screen', { streaming: true })).toBe("Done.")
		expect(stripImageDescriptionLines("Done.\n<image_desc", { streaming: true })).toBe("Done.")
	})

	it("keeps a tag written inside a sentence, and text with no such line", () => {
		const inline = 'Use <image_description id="1">x</image_description> lines.'
		expect(stripImageDescriptionLines(inline)).toBe(inline)
		expect(stripImageDescriptionLines("Plain reply.")).toBe("Plain reply.")
	})

	it("tells the model the line's form and where it goes", () => {
		expect(IMAGE_DESCRIPTION_RULE).toContain('<image_description id="')
		expect(IMAGE_DESCRIPTION_RULE).toContain("Image N:")
	})
})

// Cline Cubed: a message sent with pictures carries a short reminder of the instruction, so it is
// the last thing the model reads however long the chat is.
describe("the image description reminder", () => {
	it("follows the user's text on a line of its own", () => {
		expect(withImageDescriptionReminder("look at this")).toBe(`look at this\n${IMAGE_DESCRIPTION_REMINDER}`)
		expect(withImageDescriptionReminder("")).toBe(IMAGE_DESCRIPTION_REMINDER)
	})

	it("names the line's form", () => {
		expect(IMAGE_DESCRIPTION_REMINDER.startsWith("<image_description_reminder>")).toBe(true)
		expect(IMAGE_DESCRIPTION_REMINDER).toContain('<image_description id="N">')
	})

	it("is removed with the line break before it", () => {
		expect(stripImageDescriptionReminder(`look at this\n${IMAGE_DESCRIPTION_REMINDER}`)).toBe("look at this")
		expect(stripImageDescriptionReminder("plain")).toBe("plain")
	})
})
