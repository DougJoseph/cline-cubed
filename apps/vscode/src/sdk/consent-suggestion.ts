import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { CoreSessionConfig } from "@cline/core"
import { resolveSessionDataDir } from "@cline/shared/storage"
import type { ClineMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { CONSENT_SUGGESTION_RULE, extractConsentSuggestion } from "./consent-marker"

/**
 * Cline Cubed: when the agent's reply asks for consent or proposes an action, a one-line reply
 * granting it is suggested in the chat input, and Tab puts it in the box. The model writes the
 * suggestion itself, in a `<consent_suggestion>` line at the end of its reply (`consent-marker.ts`),
 * so no request of its own is sent for it. The suggestion is held per chat in a file beside the
 * chat so a reopened chat still shows it, and forgotten when the next message is sent.
 */

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

/** The text the model wrote in its latest message, before any tool call in it. */
function lastAssistantText(messages: readonly { role: string; content?: unknown }[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === "assistant") {
			return textOf(messages[index])
		}
	}
	return ""
}

const QUESTION_TOOLS = new Set(["ask_question", "ask_followup_question"])

export interface ConsentSuggestionExtensionOptions {
	/** Whether the Settings switch is on; read on every message. */
	enabled: () => boolean
	/** Delivers the suggestion to the chat with this session id. */
	emit: (suggestion: string, sessionId: string) => void
	/** Where chats keep their files; replaceable in tests. */
	dataDir?: () => string
}

export function createConsentSuggestionExtension(
	options: ConsentSuggestionExtensionOptions,
): NonNullable<CoreSessionConfig["extensions"]>[number] {
	let sessionId: string | undefined
	const dataDir = () => options.dataDir?.()

	/** Stores and shows the suggestion found in this text, if it holds one. */
	const suggestFrom = (id: string, text: string): void => {
		const suggestion = extractConsentSuggestion(text)
		if (!suggestion) {
			return
		}
		try {
			writeConsentSuggestion(id, suggestion, dataDir())
			options.emit(suggestion, id)
		} catch (error) {
			Logger.error(`[ConsentSuggestion] Could not keep the suggestion for chat ${id}:`, error)
		}
	}

	return {
		name: "cline-consent-suggestion",
		manifest: { capabilities: ["hooks", "rules"] },
		hooks: {
			beforeRun: () => {
				if (sessionId) {
					clearConsentSuggestion(sessionId, dataDir())
				}
				return undefined
			},
			afterRun: ({ result }) => {
				const id = sessionId
				if (!id || result.status !== "completed" || !options.enabled()) {
					return
				}
				suggestFrom(id, result.outputText ?? "")
			},
			// The question box waits for its answer inside the running turn, so the turn's end never
			// comes while it is open: the suggestion is read as the question is posted, from the text
			// the model wrote before the question.
			beforeTool: ({ toolCall, snapshot }) => {
				const id = sessionId
				if (!id || !QUESTION_TOOLS.has(toolCall.toolName) || !options.enabled()) {
					return undefined
				}
				suggestFrom(id, lastAssistantText(snapshot?.messages ?? []))
				return undefined
			},
			// Once the question is answered, its suggestion is stale.
			afterTool: ({ toolCall }) => {
				if (QUESTION_TOOLS.has(toolCall.toolName) && sessionId) {
					clearConsentSuggestion(sessionId, dataDir())
				}
				return undefined
			},
		},
		setup(api, context) {
			sessionId = context.session?.sessionId
			// The system prompt is rebuilt on every message, so the switch applies from the next one.
			api.registerRule({
				id: "cline-consent-suggestion:rule",
				source: "consent-suggestion",
				content: () => (options.enabled() ? CONSENT_SUGGESTION_RULE : ""),
			})
		},
	}
}
