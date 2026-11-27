/**
 * Cline Cubed: when the main model is the one describing images, it writes each new picture's
 * description inside its own reply, on a line of its own, so no separate describing request is
 * sent. The line is saved as that picture's description and never shown in the chat. The
 * instruction lives in the system prompt while the main model is the describer.
 */

const OPENING_TAG = "<image_description"
const CLOSING_TAG = "</image_description>"

/** The instruction added to the system prompt while the main model describes the chat's images. */
export const IMAGE_DESCRIPTION_RULE = `# Descriptions of the pictures you see

Each picture in a message comes after a line "Image N:", where N is its number. When your reply answers a message that holds such pictures, write, for each of those pictures, one line of this form near the end of the reply, before any suggested consent reply line:

${OPENING_TAG} id="N">description${CLOSING_TAG}

The description is about 150 words, for yourself later in this conversation, when you are given this description instead of the picture. Say what the picture is (for example a screenshot of a named application, a photo, a diagram) and what it shows. Quote any text that matters to understanding it, such as titles, headings, messages, errors and key numbers, but do not transcribe everything. Do not guess at what is not visible. Keep each description on one line. These lines are not shown in the chat.

Write no such line for a picture a tool returned, or for an image you were given only as a description.`

/** A whole description line: the opening tag starts the line and nothing follows the closing tag. */
const WHOLE_LINE = /^[ \t]*<image_description id="(\d+)">(.*?)<\/image_description>[ \t]*\r?$/gm
/** A last line that starts with the opening tag and has no closing tag yet. */
const UNCLOSED_LAST_LINE = /(^|\n)[ \t]*<image_description[^\n]*$/
/** A last line holding only the first characters of the opening tag. */
const PARTIAL_TAG_LAST_LINE = /(^|\n)([ \t]*<[a-z_]*)$/

/**
 * Each description in the reply, by its image number. Only a line of its own counts; a tag written
 * inside a sentence, or an empty description, gives none.
 */
export function extractImageDescriptions(text: string): Map<number, string> {
	const found = new Map<number, string>()
	for (const match of text.matchAll(WHOLE_LINE)) {
		const description = match[2].trim()
		if (description) {
			found.set(Number(match[1]), description)
		}
	}
	return found
}

/**
 * The reply as the chat shows it, with every description line removed. A tag inside a sentence
 * stays. A last line that starts with the opening tag and has no closing tag is removed too, and
 * while the reply is still arriving so is a last line holding only the tag's first characters, so
 * the line never flashes on screen. Text with no such line comes back unchanged.
 */
export function stripImageDescriptionLines(text: string, options: { streaming?: boolean } = {}): string {
	if (!text) {
		return text
	}
	let shown = text.replace(WHOLE_LINE, "")
	const unclosed = UNCLOSED_LAST_LINE.exec(shown)
	if (unclosed) {
		shown = shown.slice(0, unclosed.index + unclosed[1].length)
	}
	if (options.streaming) {
		const partial = PARTIAL_TAG_LAST_LINE.exec(shown)
		const typed = partial?.[2].trimStart()
		if (partial && typed && typed.length > 1 && OPENING_TAG.startsWith(typed)) {
			shown = shown.slice(0, partial.index + partial[1].length)
		}
	}
	return shown !== text ? shown.trimEnd() : shown
}

/**
 * The short form of the instruction, added after the user's text on each message sent with pictures
 * while the main model is the describer, so it is the last thing the model reads however long the
 * chat is. It is saved with the message and removed wherever a user message is shown
 * (`@cline/shared`, `stripModeNotices`).
 */
export const IMAGE_DESCRIPTION_REMINDER = `<image_description_reminder>For each picture after an "Image N:" line, write one line near the end of your reply: ${OPENING_TAG} id="N">description${CLOSING_TAG}</image_description_reminder>`

/** The message as sent to the model: the user's text, then the reminder on a line of its own. */
export function withImageDescriptionReminder(prompt: string): string {
	return prompt ? `${prompt}\n${IMAGE_DESCRIPTION_REMINDER}` : IMAGE_DESCRIPTION_REMINDER
}

/** A message's text with every reminder removed, and the line break before each. */
export function stripImageDescriptionReminder(text: string): string {
	const open = "<image_description_reminder>"
	const close = "</image_description_reminder>"
	let shown = text
	let start = shown.indexOf(open)
	while (start !== -1) {
		const end = shown.indexOf(close, start + open.length)
		if (end === -1) {
			break
		}
		const from = shown[start - 1] === "\n" ? start - 1 : start
		shown = shown.slice(0, from) + shown.slice(end + close.length)
		start = shown.indexOf(open, from)
	}
	return shown
}
