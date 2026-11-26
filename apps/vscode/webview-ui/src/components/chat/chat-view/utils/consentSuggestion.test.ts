import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { shouldFillConsentSuggestion, shownConsentSuggestion, splitConsentSuggestion } from "./consentSuggestion"

const text = (ts: number, value: string): ClineMessage => ({ ts, type: "say", say: "text", text: value })
const suggestion = (ts: number, value: string): ClineMessage => ({ ts, type: "say", say: "consent_suggestion", text: value })

describe("splitConsentSuggestion", () => {
	it("takes a trailing suggestion out of the chat's messages and returns its text", () => {
		const split = splitConsentSuggestion([text(1, "Should I go?"), suggestion(2, "yes, go")])
		expect(split.messages).toEqual([text(1, "Should I go?")])
		expect(split.consentSuggestion).toBe("yes, go")
	})

	it("drops a suggestion that later messages have passed, and shows none", () => {
		const split = splitConsentSuggestion([text(1, "Should I go?"), suggestion(2, "yes, go"), text(3, "yes, go")])
		expect(split.messages).toEqual([text(1, "Should I go?"), text(3, "yes, go")])
		expect(split.consentSuggestion).toBeUndefined()
	})

	it("stays current while the agent's rows are re-sent after it, whatever their order", () => {
		const at = (message: ClineMessage, createdAt: number, seq: number): ClineMessage => ({
			...message,
			createdAt,
			seq,
			epoch: 1,
		})
		// The list is not in arrival order (the task row sits last), and the reply row is re-sent
		// after the suggestion with a higher seq and the same creation millisecond.
		const current = splitConsentSuggestion([
			at(text(2, "Should I go?"), 587, 21),
			at(suggestion(9, "yes, go"), 587, 20),
			at({ ts: 5, type: "say", say: "task", text: "plan it" }, 366, 13),
		])
		expect(current.consentSuggestion).toBe("yes, go")
		expect(current.messages.map((m) => m.ts)).toEqual([2, 5])
	})

	it("goes stale once the user sends a message after it", () => {
		const at = (message: ClineMessage, createdAt: number): ClineMessage => ({ ...message, createdAt })
		const passed = splitConsentSuggestion([
			at(text(2, "Should I go?"), 100),
			at(suggestion(9, "yes, go"), 200),
			at({ ts: 10, type: "say", say: "user_feedback", text: "yes, go" }, 300),
			at(text(11, "Done."), 400),
		])
		expect(passed.consentSuggestion).toBeUndefined()
	})

	it("still counts after a reopened chat's resume entry, which is not a new message", () => {
		const resume: ClineMessage = { ts: 7, type: "ask", ask: "resume_completed_task" }
		const reopened = splitConsentSuggestion([text(1, "Should I go?"), suggestion(2, "yes, go"), resume])
		expect(reopened.consentSuggestion).toBe("yes, go")
		expect(reopened.messages).toEqual([text(1, "Should I go?"), resume])

		const stamped = splitConsentSuggestion([
			{ ...text(1, "Should I go?"), seq: 4 },
			{ ...suggestion(2, "yes, go"), seq: 5 },
			{ ts: 7, type: "ask", ask: "resume_task", seq: 6 },
		])
		expect(stamped.consentSuggestion).toBe("yes, go")
	})

	it("returns the same list when there is no suggestion", () => {
		const messages = [text(1, "Hello")]
		expect(splitConsentSuggestion(messages).messages).toBe(messages)
	})
})

describe("shownConsentSuggestion", () => {
	const ready = { consentSuggestion: "yes, go", enabled: true, inputEmpty: true, busy: false }

	it("shows the suggestion when the box is empty, the chat is ready, and the setting is on", () => {
		expect(shownConsentSuggestion(ready)).toBe("yes, go")
	})

	it("shows nothing when the box has text, the chat is busy, or the setting is off", () => {
		expect(shownConsentSuggestion({ ...ready, inputEmpty: false })).toBeUndefined()
		expect(shownConsentSuggestion({ ...ready, busy: true })).toBeUndefined()
		expect(shownConsentSuggestion({ ...ready, enabled: false })).toBeUndefined()
		expect(shownConsentSuggestion({ ...ready, consentSuggestion: undefined })).toBeUndefined()
	})
})

describe("shouldFillConsentSuggestion", () => {
	const tab = { key: "Tab", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }
	const state = { suggestion: "yes, go", inputValue: "", menuOpen: false, isComposing: false }

	it("fills the box on a plain Tab with an empty box, no open menu, and a suggestion showing", () => {
		expect(shouldFillConsentSuggestion(tab, state)).toBe(true)
	})

	it("leaves Tab alone with a modifier, text in the box, an open menu, a composition, or no suggestion", () => {
		expect(shouldFillConsentSuggestion({ ...tab, shiftKey: true }, state)).toBe(false)
		expect(shouldFillConsentSuggestion({ ...tab, metaKey: true }, state)).toBe(false)
		expect(shouldFillConsentSuggestion(tab, { ...state, inputValue: "y" })).toBe(false)
		expect(shouldFillConsentSuggestion(tab, { ...state, menuOpen: true })).toBe(false)
		expect(shouldFillConsentSuggestion(tab, { ...state, isComposing: true })).toBe(false)
		expect(shouldFillConsentSuggestion(tab, { ...state, suggestion: undefined })).toBe(false)
		expect(shouldFillConsentSuggestion({ ...tab, key: "Enter" }, state)).toBe(false)
	})
})
