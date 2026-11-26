import type { ClineMessage } from "@shared/ExtensionMessage"

/**
 * Cline Cubed: the suggested consent reply. The extension delivers it as a `consent_suggestion`
 * message at the end of the chat; it is never a row. It is taken out of the chat's messages here,
 * once, so nothing that reads "the last message" (buttons, turn state, scrolling) ever sees it.
 *
 * A suggestion counts until the user sends a message after it, which is also when the extension
 * deletes the stored one. That is read from creation times (`createdAt`, set once when a message is
 * first added), never from position or `seq`: the chat's list is not kept in arrival order (a task
 * row can sit after a later message), and the agent's own rows are re-sent after the suggestion
 * with a higher `seq` as the turn closes.
 *
 * A suggestion with no creation time (one restored to a chat reopened from history) counts when it
 * is the last message. The resume entry a reopened chat gets (`resume_task`,
 * `resume_completed_task`) is skipped there: it marks the reopening, not a new message.
 */
export function splitConsentSuggestion(messages: ClineMessage[]): {
	messages: ClineMessage[]
	consentSuggestion: string | undefined
} {
	if (!messages.some(isConsentSuggestion)) {
		return { messages, consentSuggestion: undefined }
	}
	const rest = messages.filter((message) => !isConsentSuggestion(message))
	return { messages: rest, consentSuggestion: currentSuggestion(messages, rest) }
}

function currentSuggestion(messages: ClineMessage[], rest: ClineMessage[]): string | undefined {
	const suggestions = messages.filter(isConsentSuggestion)
	const newest = suggestions.reduce((best, message) => ((message.createdAt ?? 0) >= (best.createdAt ?? 0) ? message : best))
	if (!newest.text) {
		return undefined
	}
	if (newest.createdAt === undefined) {
		const last = messages.filter((message) => !isResumeEntry(message)).at(-1)
		return last === newest ? newest.text : undefined
	}
	const createdAt = newest.createdAt
	const answeredSince = rest.some((message) => isUserMessage(message) && (message.createdAt ?? 0) > createdAt)
	return answeredSince ? undefined : newest.text
}

function isUserMessage(message: ClineMessage): boolean {
	return message.type === "say" && (message.say === "task" || message.say === "user_feedback")
}

function isResumeEntry(message: ClineMessage): boolean {
	return message.type === "ask" && (message.ask === "resume_task" || message.ask === "resume_completed_task")
}

function isConsentSuggestion(message: ClineMessage): boolean {
	return message.type === "say" && message.say === "consent_suggestion"
}

/** The suggestion to show in the empty box, or undefined when none should show. */
export function shownConsentSuggestion(state: {
	consentSuggestion: string | undefined
	enabled: boolean
	inputEmpty: boolean
	busy: boolean
}): string | undefined {
	if (!state.consentSuggestion || !state.enabled || !state.inputEmpty || state.busy) {
		return undefined
	}
	return state.consentSuggestion
}

/**
 * Whether this key press puts the suggestion in the box: Tab with no modifier keys, the box
 * empty, no slash or mention menu open (Tab picks from those), and no IME composition.
 */
export function shouldFillConsentSuggestion(
	event: { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean },
	state: { suggestion: string | undefined; inputValue: string; menuOpen: boolean; isComposing: boolean },
): boolean {
	return (
		event.key === "Tab" &&
		!event.shiftKey &&
		!event.altKey &&
		!event.ctrlKey &&
		!event.metaKey &&
		!!state.suggestion &&
		state.inputValue === "" &&
		!state.menuOpen &&
		!state.isComposing
	)
}
