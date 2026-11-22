import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiKeyField } from "./ApiKeyField"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children }: { children?: ReactNode }) => <a href="https://example.com">{children}</a>,
	VSCodeTextField: ({
		children,
		onInput,
		value,
	}: {
		children?: ReactNode
		onInput?: (event: { target: { value: string } }) => void
		value?: string
	}) => (
		<label>
			{children}
			<input
				data-testid="api-key-input"
				onChange={(event) => onInput?.({ target: { value: event.target.value } })}
				type="password"
				value={value ?? ""}
			/>
		</label>
	),
}))

describe("ApiKeyField", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	// The settings view and the onboarding provider step both tear this field
	// down while a keystroke is still inside the debounce window. A pending edit
	// that is not flushed on unmount is lost, and the field looks saved because
	// it was showing the typed value.
	it("flushes a key typed inside the debounce window when the field unmounts", async () => {
		const onChange = vi.fn()
		const { unmount } = render(<ApiKeyField initialValue="" onChange={onChange} providerName="OpenAI Compatible" />)

		fireEvent.change(screen.getByTestId("api-key-input"), { target: { value: "sk-local-123" } })
		unmount()
		await act(async () => {
			vi.advanceTimersByTime(1_000)
		})

		expect(onChange).toHaveBeenCalledWith("sk-local-123")
	})
})
