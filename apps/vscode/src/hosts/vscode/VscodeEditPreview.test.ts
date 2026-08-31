import { afterEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import { VscodeEditPreview } from "./VscodeEditPreview"

describe("VscodeEditPreview", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("opens edit previews without taking keyboard focus", async () => {
		const executeCommand = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined)
		const preview = new VscodeEditPreview()

		await preview.open({
			title: "example.ts: Original ↔ Cline's Changes (Preview)",
			absolutePath: "/workspace/example.ts",
			displayPath: "example.ts",
			leftContent: "before",
			rightContent: "after",
		})

		expect(executeCommand).toHaveBeenCalledWith(
			"vscode.diff",
			expect.any(vscode.Uri),
			expect.any(vscode.Uri),
			"example.ts: Original ↔ Cline's Changes (Preview)",
			expect.objectContaining({ preview: false, preserveFocus: true }),
		)

		// Cline Cubed: the diff is AIMED at the files group rather than landing in whichever
		// group happens to be active. Which column that resolves to depends on the tab-group
		// picture (editorGroups.test.ts covers the resolution itself); what belongs here is
		// that a column is passed at all, since passing none is the defect.
		const options = executeCommand.mock.calls[0]?.[4] as { viewColumn?: unknown }
		expect(options.viewColumn).toBeTypeOf("number")

		await preview.close()
	})
})
