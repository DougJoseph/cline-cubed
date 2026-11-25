import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ImageModeMaxOutputField } from "./ImageModeMaxOutputField"

const mocks = vi.hoisted(() => ({
	apiConfiguration: {} as Record<string, unknown>,
	commitSelection: vi.fn(async () => undefined),
	config: undefined as unknown,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ apiConfiguration: mocks.apiConfiguration }),
}))
vi.mock("@/hooks/useProviderConfig", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks/useProviderConfig")>()),
	useProviderConfig: () => ({ config: mocks.config, commitSelection: mocks.commitSelection }),
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, onInput, value }: { children?: ReactNode; onInput?: (e: unknown) => void; value?: string }) => (
		<label>
			{children}
			<input onChange={(e) => onInput?.({ target: e.target })} value={value ?? ""} />
		</label>
	),
}))

const label = "Max Output Tokens"
const edit = async (value: string) => {
	fireEvent.change(screen.getByLabelText(label), { target: { value } })
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 600))
	})
}

describe("ImageModeMaxOutputField", () => {
	beforeEach(() => {
		mocks.commitSelection.mockClear()
		mocks.apiConfiguration = { imageModeApiProvider: "deepseek", imageModeApiModelId: "vision" }
		mocks.config = { imageSelection: { modelId: "vision", modelInfo: { maxTokens: 384_000 }, overrides: undefined } }
	})

	it("shows the selected model's value", () => {
		render(<ImageModeMaxOutputField />)

		expect(screen.getByLabelText(label)).toHaveValue("384000")
	})

	it("is blank when the model has no known limit", () => {
		mocks.config = { imageSelection: { modelId: "vision", modelInfo: {} } }
		render(<ImageModeMaxOutputField />)

		expect(screen.getByLabelText(label)).toHaveValue("")
	})

	it("renders nothing without an Image Mode model", () => {
		mocks.apiConfiguration = { imageModeApiProvider: "deepseek" }
		render(<ImageModeMaxOutputField />)

		expect(screen.queryByLabelText(label)).not.toBeInTheDocument()
	})

	it("saves an edit as this model's Image Mode override", async () => {
		render(<ImageModeMaxOutputField />)

		await edit("16000")

		expect(mocks.commitSelection).toHaveBeenCalledWith("image", {
			providerId: "deepseek",
			modelId: "vision",
			overrides: { maxTokens: 16_000 },
		})
	})

	it("refuses a value that is not a positive whole number", async () => {
		render(<ImageModeMaxOutputField />)

		await edit("12.5")

		expect(mocks.commitSelection).not.toHaveBeenCalled()
		expect(screen.getByRole("alert")).toHaveTextContent("positive whole number")
	})
})
