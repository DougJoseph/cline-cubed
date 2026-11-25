import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { SettingsCheckbox } from "./SettingsCheckbox"

const toolkit = vi.hoisted(() => ({ onChange: undefined as undefined | ((event: unknown) => unknown) }))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, onChange }: { children?: ReactNode; onChange?: (event: unknown) => unknown }) => {
		toolkit.onChange = onChange
		return <button type="button">{children}</button>
	},
}))

const toolkitFiresChange = () => toolkit.onChange?.({ target: { checked: false } })

describe("SettingsCheckbox", () => {
	it("ignores a change event that no click or key produced", () => {
		const onChange = vi.fn()
		render(<SettingsCheckbox onChange={onChange}>Box</SettingsCheckbox>)

		toolkitFiresChange()

		expect(onChange).not.toHaveBeenCalled()
	})

	it("passes on the change a click produces, once", () => {
		const onChange = vi.fn()
		render(<SettingsCheckbox onChange={onChange}>Box</SettingsCheckbox>)

		fireEvent.click(screen.getByRole("button"))
		toolkitFiresChange()
		toolkitFiresChange()

		expect(onChange).toHaveBeenCalledTimes(1)
	})

	it("passes on the change the Space key produces", () => {
		const onChange = vi.fn()
		render(<SettingsCheckbox onChange={onChange}>Box</SettingsCheckbox>)

		fireEvent.keyPress(screen.getByRole("button"), { key: " ", code: "Space", charCode: 32 })
		toolkitFiresChange()

		expect(onChange).toHaveBeenCalledTimes(1)
	})

	it("ignores a later redraw once the gesture has passed", async () => {
		const onChange = vi.fn()
		render(<SettingsCheckbox onChange={onChange}>Box</SettingsCheckbox>)

		fireEvent.click(screen.getByRole("button"))
		await new Promise((resolve) => setTimeout(resolve, 1))
		toolkitFiresChange()

		expect(onChange).not.toHaveBeenCalled()
	})
})
