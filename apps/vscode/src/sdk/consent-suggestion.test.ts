import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CONSENT_SUGGESTION_RULE } from "./consent-marker"
import * as consentSuggestion from "./consent-suggestion"
import { appendStoredConsentSuggestion, createConsentSuggestionExtension, readConsentSuggestion } from "./consent-suggestion"

let dataDir: string

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "consent-suggestion-"))
})

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true })
})

const MARKED = "Plan written. Should I write the TODO lines?\n<consent_suggestion>yes, write the TODO lines</consent_suggestion>"

const userMessage = (text: string) => ({ id: "u", role: "user", content: [{ type: "text", text }], createdAt: 1 })
const result = (status: string, outputText: string) => ({
	agentId: "a",
	runId: "r",
	status,
	iterations: 1,
	outputText,
	messages: [userMessage("please plan it")],
	usage: {},
})

async function setUp(options: { enabled?: boolean } = {}) {
	let enabled = options.enabled ?? true
	const emit = vi.fn()
	const registerRule = vi.fn()
	const extension = createConsentSuggestionExtension({
		enabled: () => enabled,
		emit,
		dataDir: () => dataDir,
	})
	await extension.setup?.({ registerRule } as never, { session: { sessionId: "chat-1" } } as never)
	const finishRun = (status: string, outputText: string) =>
		extension.hooks?.afterRun?.({ snapshot: {}, result: result(status, outputText) } as never)
	const startRun = () => extension.hooks?.beforeRun?.({ snapshot: {} } as never)
	const setEnabled = (value: boolean) => {
		enabled = value
	}
	return { emit, registerRule, extension, finishRun, startRun, setEnabled }
}

describe("the instruction in the system prompt", () => {
	it("is registered as a rule, present while the setting is on and absent while it is off", async () => {
		const { registerRule, setEnabled } = await setUp()

		expect(registerRule).toHaveBeenCalledTimes(1)
		const rule = registerRule.mock.calls[0][0] as { content: () => string | Promise<string> }
		expect(await rule.content()).toBe(CONSENT_SUGGESTION_RULE)

		setEnabled(false)
		expect(await rule.content()).toBe("")
	})
})

describe("the consent suggestion after a turn", () => {
	it("takes the suggestion from the consent_suggestion line at the end of the reply, shows it, and keeps it", async () => {
		const { emit, finishRun } = await setUp()

		await finishRun("completed", MARKED)

		expect(emit).toHaveBeenCalledWith("yes, write the TODO lines", "chat-1")
		expect(readConsentSuggestion("chat-1", dataDir)).toBe("yes, write the TODO lines")
	})

	it("shows nothing for a reply with no consent_suggestion line", async () => {
		const { emit, finishRun } = await setUp()
		await finishRun("completed", "Here is the answer.")
		expect(emit).not.toHaveBeenCalled()
		expect(readConsentSuggestion("chat-1", dataDir)).toBeUndefined()
	})

	it("shows nothing after a stopped or failed turn, or with the setting off", async () => {
		const stopped = await setUp()
		await stopped.finishRun("aborted", MARKED)
		await stopped.finishRun("failed", MARKED)
		expect(stopped.emit).not.toHaveBeenCalled()

		const off = await setUp({ enabled: false })
		await off.finishRun("completed", MARKED)
		expect(off.emit).not.toHaveBeenCalled()
	})

	it("forgets the suggestion when the next message is sent", async () => {
		const { finishRun, startRun } = await setUp()
		await finishRun("completed", MARKED)
		expect(readConsentSuggestion("chat-1", dataDir)).toBeDefined()

		await startRun()

		expect(readConsentSuggestion("chat-1", dataDir)).toBeUndefined()
		expect(existsSync(join(dataDir, "chat-1", "chat-1.consent-suggestion.json"))).toBe(false)
	})

	it("sends no request of its own to the model", () => {
		expect(consentSuggestion).not.toHaveProperty("askMainModel")
		expect(consentSuggestion).not.toHaveProperty("CONSENT_SUGGESTION_PROMPT")
	})
})

describe("the question box", () => {
	const questionInput = { question: "Should I commit those files?", options: ["Yes, commit them", "No, skip it"] }
	const toolCall = { type: "tool-call", toolCallId: "q1", toolName: "ask_question", input: questionInput }
	const snapshotWith = (text: string) => ({
		messages: [userMessage("commit please"), { id: "a1", role: "assistant", content: [{ type: "text", text }, toolCall] }],
	})

	it("takes the suggestion from the text written before the question", async () => {
		const { emit, extension } = await setUp()

		await extension.hooks?.beforeTool?.({
			snapshot: snapshotWith("I can commit them.\n<consent_suggestion>yes, commit them</consent_suggestion>"),
			tool: {},
			toolCall,
			input: questionInput,
		} as never)

		expect(emit).toHaveBeenCalledWith("yes, commit them", "chat-1")
		expect(readConsentSuggestion("chat-1", dataDir)).toBe("yes, commit them")
	})

	it("drops a question's suggestion once the question is answered", async () => {
		const { extension } = await setUp()
		const snapshot = snapshotWith("<consent_suggestion>yes, commit them</consent_suggestion>")

		await extension.hooks?.beforeTool?.({ snapshot, tool: {}, toolCall, input: questionInput } as never)
		await extension.hooks?.afterTool?.({ snapshot, tool: {}, toolCall, input: questionInput, result: {} } as never)

		expect(readConsentSuggestion("chat-1", dataDir)).toBeUndefined()
	})
})

describe("a reopened chat", () => {
	it("gets its stored suggestion back as the last message", async () => {
		const { finishRun } = await setUp()
		await finishRun("completed", MARKED)

		const messages = appendStoredConsentSuggestion(
			[{ ts: 5, type: "say", say: "text", text: "Should I go?" }],
			"chat-1",
			dataDir,
		)

		expect(messages.at(-1)).toMatchObject({
			type: "say",
			say: "consent_suggestion",
			text: "yes, write the TODO lines",
		})
		expect(appendStoredConsentSuggestion([], "chat-2", dataDir)).toEqual([])
	})
})
