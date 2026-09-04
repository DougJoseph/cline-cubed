import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { OptionsButtons } from "./OptionsButtons"

const askResponseMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		askResponse: askResponseMock,
	},
}))

// This component asks the extension state which chat its surface is bound to, so the answer rides
// along on the askResponse it sends. Rendered without a provider there is nothing to ask, so the
// render throws before any assertion is reached — a gap in this file, not in the component.
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ getSurfaceBoundTaskId: () => undefined }),
}))

describe("OptionsButtons", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("removes hover affordance from the other options immediately after a selection", async () => {
		askResponseMock.mockReturnValue(new Promise(() => undefined))

		render(<OptionsButtons isActive options={["Use this", "Use that"]} />)

		const selectedButton = screen.getByRole("button", { name: "Use this" })
		const otherButton = screen.getByRole("button", { name: "Use that" })

		expect(getComputedStyle(otherButton).cursor).toBe("pointer")

		fireEvent.click(selectedButton)

		expect(askResponseMock).toHaveBeenCalledTimes(1)
		await waitFor(() => {
			expect(getComputedStyle(selectedButton).cursor).toBe("default")
			expect(getComputedStyle(otherButton).cursor).toBe("default")
		})

		fireEvent.click(otherButton)

		expect(askResponseMock).toHaveBeenCalledTimes(1)
	})

	it("re-enables options after askResponse rejects", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
		askResponseMock.mockRejectedValue(new Error("failed"))

		render(<OptionsButtons isActive options={["Use this", "Use that"]} />)

		const selectedButton = screen.getByRole("button", { name: "Use this" })
		const otherButton = screen.getByRole("button", { name: "Use that" })

		fireEvent.click(selectedButton)

		expect(askResponseMock).toHaveBeenCalledTimes(1)
		await waitFor(() => {
			expect(selectedButton).not.toBeDisabled()
			expect(otherButton).not.toBeDisabled()
			expect(getComputedStyle(otherButton).cursor).toBe("pointer")
		})

		consoleError.mockRestore()
	})
})
