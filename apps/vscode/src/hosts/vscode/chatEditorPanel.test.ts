import { describe, expect, it } from "vitest"
import { chatPanelTitle } from "./chatEditorPanel"

/**
 * Cline Cubed: an editor chat tab is labelled with its chat's name, so side-by-side chat tabs can
 * be told apart. The name is whatever `chatDisplayTitle` resolves — a renamed chat's own name, or
 * failing that its first prompt, which is arbitrary prose.
 */
describe("chatPanelTitle", () => {
	it("falls back to the extension's name when there is no chat in the tab yet", () => {
		expect(chatPanelTitle(undefined)).toBe("Cline Cubed")
	})

	it("treats a blank or whitespace-only name as no name", () => {
		expect(chatPanelTitle("")).toBe("Cline Cubed")
		expect(chatPanelTitle("   \n\t ")).toBe("Cline Cubed")
	})

	it("uses a short name as it stands", () => {
		expect(chatPanelTitle("Refactor the parser")).toBe("Refactor the parser")
	})

	it("collapses newlines and runs of whitespace — a tab strip shows one line", () => {
		expect(chatPanelTitle("Fix the\n\nlogin  bug")).toBe("Fix the login bug")
	})

	it("truncates a long first prompt to its opening words, with an ellipsis", () => {
		const title = chatPanelTitle("a".repeat(200))
		expect(title).toHaveLength(40)
		expect(title.endsWith("…")).toBe(true)
	})

	it("does not leave a dangling space before the ellipsis", () => {
		// The 40th character lands mid-gap here, so the trim has something to do.
		const title = chatPanelTitle(`${"b".repeat(38)} tail words`)
		expect(title).toBe(`${"b".repeat(38)}…`)
	})

	it("keeps a name exactly at the limit intact", () => {
		const exact = "c".repeat(40)
		expect(chatPanelTitle(exact)).toBe(exact)
	})
})
