import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ImagesSentToModelSection from "./ImagesSentToModelSection"

const mockUpdateSetting = vi.fn()
const mockExtensionState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(() => mockExtensionState.value),
}))

vi.mock("../utils/settingsHandlers", () => ({
	updateSetting: (...args: unknown[]) => mockUpdateSetting(...args),
}))

describe("ImagesSentToModelSection", () => {
	beforeEach(() => {
		mockUpdateSetting.mockClear()
		mockExtensionState.value = {}
	})

	it("shows today's limits, earlier images as pictures, and Image Mode first when nothing is stored", () => {
		render(<ImagesSentToModelSection />)

		expect(screen.getByLabelText("Earlier images")).toHaveProperty("value", "pictures")
		expect(screen.getByLabelText("All images in one request (MB)")).toHaveProperty("value", "8")
		expect(screen.getByLabelText("Each image, as sent (MB)")).toHaveProperty("value", "5")
		expect(screen.getByLabelText("Each image, decoded (MB)")).toHaveProperty("value", "6")
		expect(screen.getByLabelText("Describe images with")).toHaveProperty("value", "imageModeFirst")
	})

	it("shows stored values", () => {
		mockExtensionState.value = {
			imagesTotalLimitMb: 20,
			imagesPerImageLimitMb: 7,
			imagesPerImageDecodedLimitMb: 9,
			imageDescriber: "mainModelFirst",
			earlierImages: "descriptions",
		}
		render(<ImagesSentToModelSection />)

		expect(screen.getByLabelText("Earlier images")).toHaveProperty("value", "descriptions")
		expect(screen.getByLabelText("All images in one request (MB)")).toHaveProperty("value", "20")
		expect(screen.getByLabelText("Each image, as sent (MB)")).toHaveProperty("value", "7")
		expect(screen.getByLabelText("Each image, decoded (MB)")).toHaveProperty("value", "9")
		expect(screen.getByLabelText("Describe images with")).toHaveProperty("value", "mainModelFirst")
	})

	it("saves a valid limit", () => {
		render(<ImagesSentToModelSection />)

		fireEvent.change(screen.getByLabelText("All images in one request (MB)"), { target: { value: "12.5" } })

		expect(mockUpdateSetting).toHaveBeenCalledWith("imagesTotalLimitMb", 12.5)
	})

	it("saves the earlier-images choice", () => {
		render(<ImagesSentToModelSection />)

		fireEvent.change(screen.getByLabelText("Earlier images"), { target: { value: "descriptions" } })

		expect(mockUpdateSetting).toHaveBeenCalledWith("earlierImages", "descriptions")
	})

	it("saves the describer choice", () => {
		render(<ImagesSentToModelSection />)

		fireEvent.change(screen.getByLabelText("Describe images with"), { target: { value: "mainModelFirst" } })

		expect(mockUpdateSetting).toHaveBeenCalledWith("imageDescriber", "mainModelFirst")
	})

	it("shows an error and saves nothing for an invalid limit", () => {
		render(<ImagesSentToModelSection />)

		fireEvent.change(screen.getByLabelText("Each image, as sent (MB)"), { target: { value: "0" } })
		expect(screen.getByRole("alert").textContent).toContain("Enter a number greater than 0")

		fireEvent.change(screen.getByLabelText("Each image, as sent (MB)"), { target: { value: "abc" } })
		expect(screen.getByRole("alert").textContent).toContain("Enter a number greater than 0")

		expect(mockUpdateSetting).not.toHaveBeenCalled()
	})
})
