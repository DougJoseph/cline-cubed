import { describe, expect, it } from "vitest"
import {
	CONSENT_REMINDER,
	CONSENT_SUGGESTION_RULE,
	cleanConsentSuggestion,
	extractConsentSuggestion,
	stripConsentMarker,
	stripConsentReminder,
	withConsentReminder,
} from "./consent-marker"

describe("the instruction in the system prompt", () => {
	it("asks for the consent_suggestion line, only when the reply asks for a go", () => {
		expect(CONSENT_SUGGESTION_RULE).toContain("<consent_suggestion>")
		expect(CONSENT_SUGGESTION_RULE).toContain("</consent_suggestion>")
		expect(CONSENT_SUGGESTION_RULE).toMatch(/leave the line out/i)
	})

	it("says to write the line once, as the reply's last line, and nowhere else", () => {
		expect(CONSENT_SUGGESTION_RULE).toContain("Write this line once in a reply, as its last line, and nowhere else.")
	})
})

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

describe("extractConsentSuggestion", () => {
	it("takes the text between the tags at the end of a reply, cleaned", () => {
		expect(
			extractConsentSuggestion(
				'Plan written. Should I write the TODO lines?\n<consent_suggestion> "yes, write the TODO lines" </consent_suggestion>',
			),
		).toBe("yes, write the TODO lines")
	})

	it("gives none for no line, an empty line, NONE, or a line with no closing tag", () => {
		expect(extractConsentSuggestion("Here is the answer.")).toBeUndefined()
		expect(extractConsentSuggestion("Go?\n<consent_suggestion>  </consent_suggestion>")).toBeUndefined()
		expect(extractConsentSuggestion("Go?\n<consent_suggestion>NONE</consent_suggestion>")).toBeUndefined()
		expect(extractConsentSuggestion("Go?\n<consent_suggestion>yes, go")).toBeUndefined()
	})

	it("gives none for a tag written inside a sentence", () => {
		expect(
			extractConsentSuggestion("The form is `<consent_suggestion>yes, …</consent_suggestion>` and it is hidden.\n\nGo on?"),
		).toBeUndefined()
		expect(extractConsentSuggestion("Go? <consent_suggestion>yes, go</consent_suggestion>")).toBeUndefined()
	})

	it("takes the last line when a reply holds two", () => {
		expect(
			extractConsentSuggestion(
				"<consent_suggestion>yes, first</consent_suggestion>\nMore text.\n<consent_suggestion>yes, second</consent_suggestion>",
			),
		).toBe("yes, second")
	})
})

describe("stripConsentMarker", () => {
	it("removes the consent_suggestion line and leaves the rest of the reply", () => {
		expect(stripConsentMarker("Should I commit?\n<consent_suggestion>yes, commit</consent_suggestion>")).toBe(
			"Should I commit?",
		)
		expect(stripConsentMarker("Before.\n<consent_suggestion>yes, a</consent_suggestion>\nAfter.")).toBe("Before.\n\nAfter.")
	})

	it("removes the line even when its closing tag is missing", () => {
		expect(stripConsentMarker("Should I commit?\n<consent_suggestion>yes, com")).toBe("Should I commit?")
	})

	it("while the reply is still arriving, holds back the first characters of the opening tag", () => {
		expect(stripConsentMarker("Should I commit?\n<consent_sugg", { streaming: true })).toBe("Should I commit?\n")
		expect(stripConsentMarker("Should I commit?\n<", { streaming: true })).toBe("Should I commit?\n")
	})

	it("leaves a tag written inside a sentence, closed or not, exactly as it was", () => {
		const unclosed = "The reply ends with a `<consent_suggestion>` line. The extension reads it.\n\nSecond paragraph."
		const closed = "The form is `<consent_suggestion>yes, …</consent_suggestion>` and it is hidden.\n\nGo on?"
		expect(stripConsentMarker(unclosed)).toBe(unclosed)
		expect(stripConsentMarker(closed)).toBe(closed)
		expect(stripConsentMarker(unclosed, { streaming: true })).toBe(unclosed)
	})

	it("shows an unclosed tag again once more lines follow it", () => {
		const text = "Should I commit?\n<consent_suggestion>yes, com\nMore text."
		expect(stripConsentMarker(text, { streaming: true })).toBe(text)
	})

	it("while the reply is still arriving, holds back nothing that does not start the last line", () => {
		expect(stripConsentMarker("if a <", { streaming: true })).toBe("if a <")
		expect(stripConsentMarker("see <consent_sugg", { streaming: true })).toBe("see <consent_sugg")
	})

	it("leaves text with no consent_suggestion line exactly as it was", () => {
		expect(stripConsentMarker("a < b, and <consent is fine\n")).toBe("a < b, and <consent is fine\n")
		expect(stripConsentMarker("ends with <")).toBe("ends with <")
	})
})

describe("the reminder that rides on each message the user sends", () => {
	it("is one consent_reminder element naming the line", () => {
		expect(CONSENT_REMINDER).toBe(
			"<consent_reminder>If your reply asks for my go, end it with one line: <consent_suggestion>yes, …</consent_suggestion></consent_reminder>",
		)
	})

	it("goes after the user's text, on a line of its own", () => {
		expect(withConsentReminder("please plan it")).toBe(`please plan it\n${CONSENT_REMINDER}`)
		expect(withConsentReminder("")).toBe(CONSENT_REMINDER)
	})

	it("is removed from a message's text, leaving the rest as it was", () => {
		expect(stripConsentReminder(`<user_input mode="act">please plan it\n${CONSENT_REMINDER}</user_input>`)).toBe(
			'<user_input mode="act">please plan it</user_input>',
		)
		expect(stripConsentReminder("no reminder here")).toBe("no reminder here")
	})
})
