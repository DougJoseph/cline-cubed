import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { QwenCodeProvider } from "./QwenCodeProvider"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ apiConfiguration: { qwenCodeOauthPath: "~/custom/creds.json" } }),
}))
vi.mock("@/hooks/useStaticProviderSelection", () => ({
	useStaticProviderSelection: () => ({
		models: {},
		defaultModelId: "",
		selectedModelId: "",
		selectedModelInfo: { supportsPromptCache: false },
		hideUsageCost: false,
	}),
}))
vi.mock("../utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({ handleFieldChange: vi.fn(), handleModeFieldChange: vi.fn() }),
}))

describe("QwenCodeProvider", () => {
	it("says the OAuth path is not used by stock Cline's engine", () => {
		render(<QwenCodeProvider currentMode="act" showModelOptions={false} />)

		expect(screen.getByText("Stock Cline's current engine doesn't use this path.")).toBeInTheDocument()
	})
})
