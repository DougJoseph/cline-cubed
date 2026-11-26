import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { CoreSessionConfig } from "@cline/core"
import { resolveSessionDataDir } from "@cline/shared/storage"
import type { StateManager } from "@/core/storage/StateManager"
import type { ClineMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { buildApiHandler } from "./sdk-api-handler"

/**
 * Cline Cubed: when the agent's reply asks for consent or proposes an action, a one-line reply
 * granting it is suggested in the chat input, and Tab puts it in the box. The suggestion is written
 * after a finished turn by a short request to the chat's main model, held per chat in a file beside
 * the chat so a reopened chat still shows it, and forgotten when the next message is sent.
 */

/** The system prompt for the suggestion request. */
export const CONSENT_SUGGESTION_PROMPT = `You write one short reply for a user to send to an AI coding assistant.

Read the assistant's last reply. If it asks the user for consent, approval, or a go-ahead, or proposes an action and asks whether to do it, write the user's reply granting it: one line, under 15 words, starting "yes, ", naming the action in summary form, for example "yes, write the plan doc and TODO lines".

If the reply asks for no consent and proposes no action, write exactly NONE.

Output only the reply or NONE, with no quotes and no explanation.`

const MAX_SUGGESTION_CHARS = 160
/** How much of the reply and the user's message the request carries. */
const MAX_CONTEXT_CHARS = 4_000

/** The model's answer as a suggestion, or undefined when there is none to show. */
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

export function consentSuggestionPath(sessionId: string, dataDir: string = resolveSessionDataDir()): string {
	return join(dataDir, sessionId, `${sessionId}.consent-suggestion.json`)
}

export function readConsentSuggestion(sessionId: string, dataDir?: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(consentSuggestionPath(sessionId, dataDir), "utf8")) as { suggestion?: unknown }
		return typeof parsed.suggestion === "string" && parsed.suggestion ? parsed.suggestion : undefined
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			Logger.error(`[ConsentSuggestion] Could not read the suggestion for chat ${sessionId}:`, error)
		}
		return undefined
	}
}

function writeConsentSuggestion(sessionId: string, suggestion: string, dataDir?: string): void {
	const file = consentSuggestionPath(sessionId, dataDir)
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, `${JSON.stringify({ suggestion }, null, 2)}\n`, "utf8")
}

function clearConsentSuggestion(sessionId: string, dataDir?: string): void {
	rmSync(consentSuggestionPath(sessionId, dataDir), { force: true })
}

/** The chat message that carries a suggestion to the chat view; never shown as a row. */
export function consentSuggestionMessage(suggestion: string, ts: number = Date.now()): ClineMessage {
	return { ts, type: "say", say: "consent_suggestion", text: suggestion, partial: false }
}

/** A reopened chat's messages, with its stored suggestion added back as the last message. */
export function appendStoredConsentSuggestion(messages: ClineMessage[], sessionId: string, dataDir?: string): ClineMessage[] {
	const suggestion = readConsentSuggestion(sessionId, dataDir)
	if (!suggestion) {
		return messages
	}
	const lastTs = messages.at(-1)?.ts ?? 0
	return [...messages, consentSuggestionMessage(suggestion, lastTs + 1)]
}

function textOf(message: { content?: unknown } | undefined): string {
	if (!message || !Array.isArray(message.content)) {
		return ""
	}
	return message.content
		.map((part: { type?: string; text?: string }) =>
			part?.type === "text" && typeof part.text === "string" ? part.text : "",
		)
		.join("\n")
		.trim()
}

function lastUserText(messages: readonly { role: string; content?: unknown }[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === "user") {
			const text = textOf(messages[index])
			if (text) {
				return text
			}
		}
	}
	return ""
}

/** The question tool's question and its answer options, as the suggestion request reads them. */
function questionText(input: unknown): string {
	const fields = input as { question?: unknown; options?: unknown } | undefined
	const question = typeof fields?.question === "string" ? fields.question.trim() : ""
	if (!question) {
		return ""
	}
	const choices = Array.isArray(fields?.options)
		? fields.options.filter((option): option is string => typeof option === "string")
		: []
	return choices.length > 0 ? `${question}\n\nAnswer options:\n${choices.map((option) => `- ${option}`).join("\n")}` : question
}

const QUESTION_TOOLS = new Set(["ask_question", "ask_followup_question"])

/** The end of a long text, where a closing question sits. */
function tail(text: string): string {
	return text.length > MAX_CONTEXT_CHARS ? `…${text.slice(-MAX_CONTEXT_CHARS)}` : text
}

export interface ConsentSuggestionExtensionOptions {
	/** Whether the Settings switch is on; read at the end of each turn. */
	enabled: () => boolean
	/** Sends one request to the chat's main model and returns its text. */
	ask: (systemPrompt: string, userText: string) => Promise<string>
	/** Delivers the suggestion to the chat with this session id. */
	emit: (suggestion: string, sessionId: string) => void
	/** Where chats keep their files; replaceable in tests. */
	dataDir?: () => string
}

export function createConsentSuggestionExtension(
	options: ConsentSuggestionExtensionOptions,
): NonNullable<CoreSessionConfig["extensions"]>[number] {
	let sessionId: string | undefined
	// Counts runs and answered questions, so a suggestion still being written when the next message
	// is sent, or when its question is answered, is dropped.
	let runCount = 0
	const dataDir = () => options.dataDir?.()

	/** Asks for a suggestion for this reply, then stores and shows it unless the chat moved on meanwhile. */
	const suggest = async (id: string, userText: string, reply: string): Promise<void> => {
		const runAtStart = runCount
		try {
			const answer = await options.ask(
				CONSENT_SUGGESTION_PROMPT,
				`The user's last message:\n${tail(userText) || "(none)"}\n\nThe assistant's last reply:\n${tail(reply)}`,
			)
			const suggestion = cleanConsentSuggestion(answer)
			if (!suggestion || runCount !== runAtStart) {
				return
			}
			writeConsentSuggestion(id, suggestion, dataDir())
			options.emit(suggestion, id)
		} catch (error) {
			Logger.error(`[ConsentSuggestion] Could not write a suggestion for chat ${id}:`, error)
		}
	}

	return {
		name: "cline-consent-suggestion",
		manifest: { capabilities: ["hooks"] },
		hooks: {
			beforeRun: () => {
				runCount++
				if (sessionId) {
					clearConsentSuggestion(sessionId, dataDir())
				}
				return undefined
			},
			afterRun: async ({ result }) => {
				const id = sessionId
				if (!id || result.status !== "completed" || !options.enabled()) {
					return
				}
				const reply = result.outputText?.trim()
				if (!reply) {
					return
				}
				await suggest(id, lastUserText(result.messages), reply)
			},
			// The question box waits for its answer inside the running turn, so the turn's end never
			// comes while it is open: the suggestion is requested as the question is posted, without
			// holding the question up.
			beforeTool: ({ toolCall, input, snapshot }) => {
				const id = sessionId
				if (!id || !QUESTION_TOOLS.has(toolCall.toolName) || !options.enabled()) {
					return undefined
				}
				const reply = questionText(input ?? toolCall.input)
				if (reply) {
					void suggest(id, lastUserText(snapshot?.messages ?? []), reply)
				}
				return undefined
			},
			// Once the question is answered, its suggestion is stale.
			afterTool: ({ toolCall }) => {
				if (QUESTION_TOOLS.has(toolCall.toolName)) {
					runCount++
					if (sessionId) {
						clearConsentSuggestion(sessionId, dataDir())
					}
				}
				return undefined
			},
		},
		setup(_api, context) {
			sessionId = context.session?.sessionId
		},
	}
}

/** One request to the chat's main model, with no tools and no reasoning, answering its text. */
export async function askMainModel(stateManager: StateManager, systemPrompt: string, userText: string): Promise<string> {
	const mode = stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"
	// No token limit: a model that reasons before answering would spend a small limit before any
	// answer came back. The prompt's word limit sets the length.
	const handler = buildApiHandler(stateManager.getApiConfiguration(), mode, { disableReasoning: true })
	let answer = ""
	let failure: string | undefined
	for await (const chunk of handler.createMessage(systemPrompt, [
		{ role: "user", content: [{ type: "text", text: userText }] },
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
	return answer
}
