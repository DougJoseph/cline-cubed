/**
 * Cline Cubed: a reply that asks for a go ends with one `<consent_suggestion>` line holding the
 * reply that grants it. That line becomes the chat input's suggested reply and is never shown in
 * the chat. The instruction lives in the system prompt, which is the same on every message, so the
 * suggestion costs no request of its own.
 */

const OPENING_TAG = "<consent_suggestion>"
const CLOSING_TAG = "</consent_suggestion>"
const MAX_SUGGESTION_CHARS = 160

/** The instruction added to the system prompt while the setting is on. */
export const CONSENT_SUGGESTION_RULE = `# Suggested consent reply

When your reply asks for consent, approval, or a go-ahead, or proposes an action and asks whether to do it, end the reply with one line of this form, after everything else:

${OPENING_TAG}yes, write the plan doc and TODO lines${CLOSING_TAG}

Write this line once in a reply, as its last line, and nowhere else. Between the tags, write the one-line reply that grants what you asked: under 15 words, starting "yes, ", naming the action in summary form. The line is not shown in the chat; it is offered as a suggested reply. When you ask with a question tool, put the line in your text before the tool call, never in the tool's input.

When your reply asks for no consent and proposes no action, leave the line out.`

/** A suggested reply as shown, or undefined when there is none to show. */
export function cleanConsentSuggestion(raw: string): string | undefined {
	const firstLine =
		raw
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? ""
	const unquoted = firstLine.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim()
	if (!unquoted || /^none\.?$/i.test(unquoted) || unquoted.length > MAX_SUGGESTION_CHARS) {
		return undefined
	}
	return unquoted
}

/** A whole `<consent_suggestion>` line: the opening tag starts the line and nothing follows the closing tag. */
const WHOLE_LINE = /^[ \t]*<consent_suggestion>(.*?)<\/consent_suggestion>[ \t]*\r?$/gm
/** A last line that starts with the opening tag and has no closing tag yet. */
const UNCLOSED_LAST_LINE = /(^|\n)[ \t]*<consent_suggestion>[^\n]*$/
/** A last line holding only the first characters of the opening tag. */
const PARTIAL_TAG_LAST_LINE = /(^|\n)([ \t]*<[a-z_]*)$/

/**
 * The suggestion: the text between the tags of the last `<consent_suggestion>` line in the reply.
 * Only a line of its own counts; a tag written inside a sentence gives none. A line with nothing in
 * it, "NONE", or no closing tag gives none.
 */
export function extractConsentSuggestion(text: string): string | undefined {
	let last: string | undefined
	for (const match of text.matchAll(WHOLE_LINE)) {
		last = match[1]
	}
	return last === undefined ? undefined : cleanConsentSuggestion(last)
}

/**
 * The reply as the chat shows it, with every `<consent_suggestion>` line removed. Only a line of its
 * own is removed; a tag written inside a sentence stays. A last line that starts with the opening
 * tag and has no closing tag is removed too, and while the reply is still arriving so is a last line
 * holding only the tag's first characters, so the line never flashes on screen. Text with no such
 * line comes back unchanged.
 */
export function stripConsentMarker(text: string, options: { streaming?: boolean } = {}): string {
	if (!text) {
		return text
	}
	let shown = text.replace(WHOLE_LINE, "")
	const unclosed = UNCLOSED_LAST_LINE.exec(shown)
	if (unclosed) {
		shown = shown.slice(0, unclosed.index + unclosed[1].length)
	}
	const lineRemoved = shown !== text
	if (options.streaming) {
		const partial = PARTIAL_TAG_LAST_LINE.exec(shown)
		if (partial && OPENING_TAG.startsWith(partial[2].trimStart())) {
			shown = shown.slice(0, partial.index + partial[1].length)
		}
	}
	return lineRemoved ? shown.trimEnd() : shown
}

/**
 * The short form of the instruction, added after the user's text on each message sent while the
 * setting is on, so it is the last thing the model reads before it answers however long the chat
 * is. It is saved with the message and removed wherever a user message is shown (`@cline/shared`,
 * `stripModeNotices`).
 */
export const CONSENT_REMINDER = `<consent_reminder>If your reply asks for my go, end it with one line: ${OPENING_TAG}yes, …${CLOSING_TAG}</consent_reminder>`

/** The message as sent to the model: the user's text, then the reminder on a line of its own. */
export function withConsentReminder(prompt: string): string {
	return prompt ? `${prompt}\n${CONSENT_REMINDER}` : CONSENT_REMINDER
}

/** A message's text with every reminder removed, and the line break before each. */
export function stripConsentReminder(text: string): string {
	const open = "<consent_reminder>"
	const close = "</consent_reminder>"
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
