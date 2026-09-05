import type { ApiConfiguration } from "@shared/api"
import type { Mode } from "@shared/storage/types"
import { buildApiHandler } from "@/sdk/sdk-api-handler"
import { Logger } from "@/shared/services/Logger"

/**
 * Cline Cubed — name a chat from its first prompt.
 *
 * A chat is displayed by its first prompt until someone renames it, so a list of chats reads as a
 * list of opening sentences rather than a list of subjects. This asks the model for a short name
 * instead, and the name is stored EXACTLY AS IF THE PERSON HAD TYPED IT — through the rename
 * feature's own path (`applyName` is `SdkController.setTaskTitle` behind a "no name yet" guard).
 * There is no second name key and no precedence logic: a typed name is a name, and a chat that
 * has one is left alone.
 *
 * THE PERSON'S OWN PROVIDER DOES THE WORK. No second provider, no model of ours, no key of ours —
 * the request goes to whatever they have configured, in whichever channel the chat is in at that
 * moment (Plan or Act). When that provider is offline or refuses, no name arrives and the chat
 * keeps showing its first prompt. Nothing is shown to the person; the failure IS reported to the
 * log, unconditionally — see the three failure sites below.
 *
 * It is fired ALONGSIDE the first turn and never awaited, so it cannot delay the first reply.
 */

/** What fits an editor tab and a list row without truncation. Six words, sixty characters. */
export const MAX_CHAT_NAME_LENGTH = 60

/**
 * The ask, in Doug's own words (2026-09-04). Sent as the system prompt, with the person's first
 * prompt as the user turn. BOTH limits are stated, and the character one is interpolated from
 * `MAX_CHAT_NAME_LENGTH` so the number the model is given can never drift from the number that is
 * enforced.
 */
export const CHAT_NAME_INSTRUCTION = `Give this coding-chat request a name of at most six words and ${MAX_CHAT_NAME_LENGTH} characters. Reply with the name only — no punctuation, no quotes, no explanation.`

/**
 * Past this, the answer is not a name at all — a model that replied in a sentence, or several.
 * Below it, an over-long answer is TRUNCATED rather than thrown away (Doug's ruling): discarding a
 * usable title over a formatting detail is the wrong trade, and a tab strip truncates anyway.
 */
const NOT_A_NAME_LENGTH = MAX_CHAT_NAME_LENGTH * 4

/**
 * How much of the first prompt is sent. A first prompt can be a pasted log; naming a chat is not
 * worth shipping one to the model, and the subject is always in the opening lines.
 */
const PROMPT_EXCERPT_LENGTH = 2000

/** Quote characters a model adds despite being told not to — straight, curly, and backtick. */
const SURROUNDING_QUOTES = /^["'“”‘’`]+|["'“”‘’`]+$/g

/**
 * The model's answer, turned into a name — or `undefined` when it is not a name.
 *
 * Trimmed, and surrounding quotes stripped. An over-long name is truncated at a word boundary.
 * Only an answer that is not a name at all is discarded: empty, carrying a line break, or far
 * past the limit.
 */
export function extractChatName(raw: string): string | undefined {
	const name = raw.trim().replace(SURROUNDING_QUOTES, "").trim()
	if (!name) {
		return undefined
	}
	if (/[\r\n]/.test(name)) {
		return undefined
	}
	if (name.length > NOT_A_NAME_LENGTH) {
		return undefined
	}
	if (name.length <= MAX_CHAT_NAME_LENGTH) {
		return name
	}
	return truncateAtWordBoundary(name, MAX_CHAT_NAME_LENGTH)
}

/** Cut to `limit` characters INCLUDING the one-character ellipsis, at the last whole word. */
function truncateAtWordBoundary(name: string, limit: number): string {
	const cut = name.slice(0, limit - 1)
	const lastSpace = cut.lastIndexOf(" ")
	const head = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()
	return `${head}…`
}

export interface AutoNameChatInput {
	/** The chat being named. */
	sessionId: string
	/** What the person typed, before any wrapping or context-mention expansion. */
	prompt: string
	/** The channel the chat is in at this moment — the model they chose to work with. */
	mode: Mode
	apiConfiguration: ApiConfiguration
	/**
	 * Stores the name the way a rename does. Expected to do nothing when the chat already has a
	 * name — that check is the caller's, since it owns the history.
	 */
	applyName: (sessionId: string, name: string) => Promise<void>
}

/**
 * Asks for the name and stores it. Returns the name it stored, or `undefined` when there is
 * nothing to store. Throws on a provider failure — see `autoNameChatInBackground`, which is how
 * every caller should reach this.
 */
export async function autoNameChat(input: AutoNameChatInput): Promise<string | undefined> {
	const prompt = input.prompt.trim().slice(0, PROMPT_EXCERPT_LENGTH)
	if (!prompt) {
		return undefined
	}

	// A name is a fast one-shot transform that does not need extended thinking; disabling
	// reasoning also avoids sending both reasoning.effort and reasoning.max_tokens, which some
	// providers reject (the same reason the commit-message generator disables it).
	const handler = buildApiHandler(input.apiConfiguration, input.mode, { disableReasoning: true })

	let answer = ""
	let streamError: string | undefined
	for await (const chunk of handler.createMessage(CHAT_NAME_INSTRUCTION, [{ role: "user", content: prompt }])) {
		if (chunk.type === "text") {
			answer += chunk.text
		} else if (chunk.type === "done" && chunk.success === false) {
			streamError = chunk.error
		}
	}

	if (streamError) {
		// UNGATED: a failed request is an error. Gating it behind the debug switch is how a live
		// failure leaves no trace at all (CLAUDE.md §3.4).
		Logger.error(`Chat naming: provider error for ${input.sessionId} — ${streamError}`)
		return undefined
	}

	const name = extractChatName(answer)
	if (!name) {
		// UNGATED: not an exception, but a failed operation that spent a request and produced
		// nothing — reported, not swallowed.
		Logger.warn(`Chat naming: no usable name for ${input.sessionId} (answer was ${answer.length} characters)`)
		return undefined
	}

	await input.applyName(input.sessionId, name)
	Logger.debug(`Chat naming: ${input.sessionId} named "${name}"`)
	return name
}

/**
 * Fire the naming request and forget it. Nothing waits on it; the chat simply keeps showing its
 * first prompt if no name arrives.
 */
export function autoNameChatInBackground(input: AutoNameChatInput): void {
	void autoNameChat(input).catch((error: unknown) => {
		// UNGATED, and the most important of the three: this catch receives anything thrown by
		// the request OR by storing the name.
		Logger.error(`Chat naming: failed for ${input.sessionId} — ${error instanceof Error ? error.message : String(error)}`)
	})
}
