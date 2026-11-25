import { render, renderHook, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useDynamicProviderSelection } from "@/hooks/useDynamicProviderSelection"
import { useProviderConfig } from "@/hooks/useProviderConfig"
import { useProviderModelSelection } from "@/hooks/useProviderModelSelection"
import { useProviderModels } from "@/hooks/useProviderModels"
import { useStaticProviderSelection } from "@/hooks/useStaticProviderSelection"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import { DifyProvider } from "./DifyProvider"
import { ModelPickerWithManualEntry } from "./ModelPickerWithManualEntry"

vi.mock("@/hooks/useProviderModels", () => ({ useProviderModels: vi.fn() }))
vi.mock("@/hooks/useProviderConfig", () => ({ useProviderConfig: vi.fn() }))
vi.mock("@/hooks/useProviderUsageCostDisplay", () => ({ useProviderUsageCostDisplay: () => "show" }))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ apiConfiguration: {}, planActSeparateModelsSetting: false }),
}))
vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: { updateApiConfiguration: vi.fn(async () => undefined) },
	StateServiceClient: { updateSettings: vi.fn(async () => undefined) },
}))
vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@vscode/webview-ui-toolkit/react")>()
	return {
		...actual,
		VSCodeDropdown: ({ children, value }: { children?: ReactNode; value?: string }) => (
			<select aria-label="Model" onChange={() => undefined} value={value}>
				{children}
			</select>
		),
		VSCodeOption: ({ children, value }: { children?: ReactNode; value?: string }) => (
			<option value={value}>{children}</option>
		),
	}
})

const catalog = { "catalog-default": { name: "Default", contextWindow: 200_000, supportsPromptCache: true } }

function mockProvider(config?: object) {
	vi.mocked(useProviderModels).mockReturnValue({
		models: catalog,
		defaultModelId: "catalog-default",
		isLoading: false,
		isStale: false,
		error: undefined,
		refresh: vi.fn(),
		fingerprint: "fingerprint",
	} as never)
	vi.mocked(useProviderConfig).mockReturnValue({
		config,
		write: vi.fn(async () => undefined),
		commitSelection: vi.fn(async () => undefined),
	} as never)
}

describe.each(["plan", "act", "image"] as const)("an empty %s model", (mode) => {
	beforeEach(() => mockProvider({}))

	it("is empty in the catalog-backed selection", () => {
		const { result } = renderHook(() =>
			useProviderModelSelection("gemini", mode, { models: catalog, commitSelection: vi.fn(), config: {} as never }),
		)
		expect(result.current.selectedModelId).toBe("")
		expect(result.current.selectedModelInfo.contextWindow).toBeUndefined()
	})

	it("is empty in the static selection, even with another provider's value in the shared slot", () => {
		const slot = mode === "plan" ? "planModeApiModelId" : mode === "image" ? "imageModeApiModelId" : "actModeApiModelId"
		const { result } = renderHook(() => useStaticProviderSelection("qwen", { [slot]: "deepseek-reasoner" }, mode))
		expect(result.current.selectedModelId).toBe("")
		expect(result.current.selectedModelInfo.contextWindow).toBeUndefined()
	})

	it("has no made-up details in the dynamic selection", () => {
		const { result } = renderHook(() => useDynamicProviderSelection("openrouter", {}, mode))
		expect(result.current.selectedModelId).toBe("")
		expect(result.current.selectedModelInfo.contextWindow).toBeUndefined()
	})
})

describe("the empty state on screen", () => {
	beforeEach(() => mockProvider({}))

	it("the model details say no model is selected and show no size or price", () => {
		render(<ModelInfoView modelInfo={{ supportsPromptCache: false, contextWindow: 128_000 }} selectedModelId="" />)
		expect(screen.getByRole("status")).toHaveTextContent("No model selected.")
		expect(screen.queryByText(/Context:/)).not.toBeInTheDocument()
	})

	it("the dropdown shows No model selected", () => {
		render(<ModelSelector models={catalog} onChange={vi.fn()} selectedModelId="" />)
		expect(screen.getByLabelText("Model")).toHaveDisplayValue("No model selected")
	})

	it("the dropdown offers no blank choice once a model is selected", () => {
		render(<ModelSelector models={catalog} onChange={vi.fn()} selectedModelId="catalog-default" />)
		expect(screen.queryByText("No model selected")).not.toBeInTheDocument()
	})

	it("the manual-entry picker shows No model selected rather than its first model", () => {
		render(
			<ModelPickerWithManualEntry
				allowsCustomIds={false}
				isLoading={false}
				isStale={false}
				models={catalog}
				onSelect={vi.fn()}
				selectedModel={{ providerId: "gemini", modelId: "", modelInfo: { supportsPromptCache: false } }}
			/>,
		)
		expect(screen.getByLabelText("Model")).toHaveDisplayValue("No model selected")
	})

	it("Dify says its application sets the model", () => {
		render(<DifyProvider currentMode="plan" showModelOptions={true} />)
		expect(screen.getByText("Model: Set by your Dify application.")).toBeInTheDocument()
		expect(screen.queryByText(/Context:/)).not.toBeInTheDocument()
	})
})
