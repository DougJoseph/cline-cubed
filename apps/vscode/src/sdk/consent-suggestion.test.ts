import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	appendStoredConsentSuggestion,
	askMainModel,
	cleanConsentSuggestion,
	createConsentSuggestionExtension,
	readConsentSuggestion,
} from "./consent-suggestion"

const apiHandler = vi.hoisted(() => ({ buildApiHandler: vi.fn() }))
vi.mock("./sdk-api-handler", () => apiHandler)

let dataDir: string

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "consent-suggestion-"))
})

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true })
})

const userMessage = (text: string) => ({ id: "u", role: "user", content: [{ type: "text", text }], createdAt: 1 })
const result = (status: string, outputText: string, messages = [userMessage("please plan it")]) => ({
	agentId: "a",
	runId: "r",
	status,
	iterations: 1,
	outputText,
	messages,
	usage: {},
})

async function setUp(options: { enabled?: boolean; answer?: string | Error } = {}) {
	const ask = vi.fn(async () => {
		if (options.answer instanceof Error) throw options.answer
		return options.answer ?? "yes, write the plan doc and TODO lines"
	})
	const emit = vi.fn()
	const extension = createConsentSuggestionExtension({
		enabled: () => options.enabled ?? true,
		ask,
		emit,
		dataDir: () => dataDir,
	})
	await extension.setup?.({} as never, { session: { sessionId: "chat-1" } } as never)
	const finishRun = (status: string, outputText: string) =>
		extension.hooks?.afterRun?.({ snapshot: {}, result: result(status, outputText) } as never)
	const startRun = () => extension.hooks?.beforeRun?.({ snapshot: {} } as never)
	return { ask, emit, finishRun, startRun }
}

describe("cleanConsentSuggestion", () => {
	it("keeps one short line", () => {
		expect(cleanConsentSuggestion('  "yes, write the plan doc and TODO lines"\nextra')).toBe(
			"yes, write the plan doc and TODO lines",
		)
	})

	it("drops NONE, an empty answer, and an overlong one", () => {
		expect(cleanConsentSuggestion("NONE")).toBeUndefined()
		expect(cleanConsentSuggestion("none.")).toBeUndefined()
		expect(cleanConsentSuggestion("   ")).toBeUndefined()
		expect(cleanConsentSuggestion(`yes, ${"word ".repeat(80)}`)).toBeUndefined()
	})
})

describe("the consent suggestion after a turn", () => {
	it("asks the main model after a finished turn with the reply and the user's message, shows it, and keeps it", async () => {
		const { ask, emit, finishRun } = await setUp()

		await finishRun("completed", "Plan written. Should I write the plan doc and TODO lines?")

		expect(ask).toHaveBeenCalledTimes(1)
		const [, prompt] = ask.mock.calls[0] as unknown as [string, string]
		expect(prompt).toContain("Should I write the plan doc and TODO lines?")
		expect(prompt).toContain("please plan it")
		expect(emit).toHaveBeenCalledWith("yes, write the plan doc and TODO lines", "chat-1")
		expect(readConsentSuggestion("chat-1", dataDir)).toBe("yes, write the plan doc and TODO lines")
	})

	it("shows nothing for NONE or a failed request", async () => {
		const none = await setUp({ answer: "NONE" })
		await none.finishRun("completed", "Here is the answer.")
		expect(none.emit).not.toHaveBeenCalled()

		const failing = await setUp({ answer: new Error("server down") })
		await expect(failing.finishRun("completed", "Should I go?")).resolves.toBeUndefined()
		expect(failing.emit).not.toHaveBeenCalled()
		expect(readConsentSuggestion("chat-1", dataDir)).toBeUndefined()
	})

	it("asks nothing after a stopped or failed turn, or with the setting off", async () => {
		const stopped = await setUp()
		await stopped.finishRun("aborted", "Should I go?")
		await stopped.finishRun("failed", "Should I go?")
		expect(stopped.ask).not.toHaveBeenCalled()

		const off = await setUp({ enabled: false })
		await off.finishRun("completed", "Should I go?")
		expect(off.ask).not.toHaveBeenCalled()
	})

	it("forgets the suggestion when the next message is sent", async () => {
		const { finishRun, startRun } = await setUp()
		await finishRun("completed", "Should I go?")
		expect(readConsentSuggestion("chat-1", dataDir)).toBeDefined()

		await startRun()

		expect(readConsentSuggestion("chat-1", dataDir)).toBeUndefined()
		expect(existsSync(join(dataDir, "chat-1", "chat-1.consent-suggestion.json"))).toBe(false)
	})
})

describe("the two ways a model asks for a go", () => {
	it("asks for a suggestion when the question box is posted, with the question and its options", async () => {
		const { ask, emit } = await setUp({ answer: "yes, commit them" })
		const extension = createConsentSuggestionExtension({ enabled: () => true, ask, emit, dataDir: () => dataDir })
		await extension.setup?.({} as never, { session: { sessionId: "chat-1" } } as never)
		const input = { question: "Should I commit those files?", options: ["Yes, commit them", "No, skip it"] }

		await extension.hooks?.beforeTool?.({
			snapshot: {},
			tool: {},
			toolCall: { type: "tool-call", toolCallId: "q1", toolName: "ask_question", input },
			input,
		} as never)

		await vi.waitFor(() => expect(emit).toHaveBeenCalledWith("yes, commit them", "chat-1"))
		const [, prompt] = ask.mock.calls[0] as unknown as [string, string]
		expect(prompt).toContain("Should I commit those files?")
		expect(prompt).toContain("No, skip it")
		expect(readConsentSuggestion("chat-1", dataDir)).toBe("yes, commit them")
	})

	it("drops a question's suggestion once the question is answered", async () => {
		let finish: (value: string) => void = () => {}
		const ask = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)))
		const emit = vi.fn()
		const extension = createConsentSuggestionExtension({ enabled: () => true, ask, emit, dataDir: () => dataDir })
		await extension.setup?.({} as never, { session: { sessionId: "chat-1" } } as never)
		const input = { question: "Should I commit those files?", options: ["Yes", "No"] }
		const toolCall = { type: "tool-call", toolCallId: "q1", toolName: "ask_question", input }

		await extension.hooks?.beforeTool?.({ snapshot: {}, tool: {}, toolCall, input } as never)
		await extension.hooks?.afterTool?.({ snapshot: {}, tool: {}, toolCall, input, result: {} } as never)
		finish("yes, commit them")
		await new Promise((resolve) => setTimeout(resolve, 20))

		expect(emit).not.toHaveBeenCalled()
		expect(readConsentSuggestion("chat-1", dataDir)).toBeUndefined()
	})
})

describe("the request to the chat's model", () => {
	it("sets no token limit and uses the answer that follows the model's reasoning", async () => {
		apiHandler.buildApiHandler.mockReturnValue({
			async *createMessage() {
				yield { type: "reasoning", reasoning: "The user asked for consent to commit, so" }
				yield { type: "reasoning", reasoning: " the reply should grant it." }
				yield { type: "text", text: "yes, commit them" }
				yield { type: "done", success: true }
			},
		})
		const stateManager = { getGlobalSettingsKey: () => "act", getApiConfiguration: () => ({}) }

		const answer = await askMainModel(stateManager as never, "system", "Should I commit them?")

		expect(answer).toBe("yes, commit them")
		const [, , buildOptions] = apiHandler.buildApiHandler.mock.calls[0] as unknown as [
			unknown,
			unknown,
			Record<string, unknown>,
		]
		expect(buildOptions).not.toHaveProperty("maxOutputTokens")
	})
})

describe("a reopened chat", () => {
	it("gets its stored suggestion back as the last message", async () => {
		const { finishRun } = await setUp()
		await finishRun("completed", "Should I go?")

		const messages = appendStoredConsentSuggestion(
			[{ ts: 5, type: "say", say: "text", text: "Should I go?" }],
			"chat-1",
			dataDir,
		)

		expect(messages.at(-1)).toMatchObject({
			type: "say",
			say: "consent_suggestion",
			text: "yes, write the plan doc and TODO lines",
		})
		expect(appendStoredConsentSuggestion([], "chat-2", dataDir)).toEqual([])
	})
})
