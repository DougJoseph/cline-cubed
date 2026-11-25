import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ChangeEvent, ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { BedrockProvider } from "./BedrockProvider"
import OcaModelPicker from "./OcaModelPicker"

/**
 * Cline Cubed: the OCA and Bedrock pickers show an empty model slot as "No model selected",
 * never the provider's catalog default, and a model chosen on a tab is written to that tab's
 * own slot.
 */

const mocks = vi.hoisted(() => ({
	handleModeFieldsChange: vi.fn(async () => undefined),
	commitSelection: vi.fn(async () => undefined),
	write: vi.fn(async () => undefined),
}))

const info = { name: "Model A", contextWindow: 100_000, supportsPromptCache: false, maxTokens: 4_096 }

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ apiConfiguration: {}, remoteConfigSettings: {}, planActSeparateModelsSetting: true }),
}))

vi.mock("@/hooks/useProviderModels", () => ({
	useProviderModels: () => ({
		models: { "model-a": info, "catalog-default": { ...info, name: "Default" } },
		defaultModelId: "catalog-default",
		isLoading: false,
		isStale: false,
		error: undefined,
		refresh: vi.fn(),
		fingerprint: "fingerprint",
	}),
}))

vi.mock("@/hooks/useProviderUsageCostDisplay", () => ({ useProviderUsageCostDisplay: () => "show" }))

vi.mock("@/hooks/useProviderConfig", () => ({
	useProviderConfig: () => ({ config: {}, write: mocks.write, commitSelection: mocks.commitSelection }),
}))

vi.mock("../utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({
		handleFieldChange: vi.fn(async () => undefined),
		handleFieldsChange: vi.fn(async () => undefined),
		handleModeFieldChange: vi.fn(async () => undefined),
		handleModeFieldsChange: mocks.handleModeFieldsChange,
	}),
}))

vi.mock("@/services/grpc-client", () => {
	const client = new Proxy({}, { get: () => vi.fn(async () => ({})) })
	return { ModelsServiceClient: client, StateServiceClient: client, UiServiceClient: client, AccountServiceClient: client }
})

vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@vscode/webview-ui-toolkit/react")>()
	return {
		...actual,
		VSCodeDropdown: ({
			children,
			id,
			onChange,
			value,
		}: {
			children?: ReactNode
			id?: string
			onChange?: (event: ChangeEvent<HTMLSelectElement>) => void
			value?: string
		}) => (
			<select data-testid={id} onChange={onChange} value={value}>
				{children}
			</select>
		),
		VSCodeOption: ({ children, value }: { children?: ReactNode; value?: string }) => (
			<option value={value}>{children}</option>
		),
	}
})

const ocaModels = { "model-a": { ...info, reasoningEffortOptions: [] } } as never

describe("the OCA picker with an empty slot", () => {
	beforeEach(() => mocks.handleModeFieldsChange.mockClear())

	it("shows No model selected and no model details", () => {
		render(<OcaModelPicker apiConfiguration={{}} currentMode="plan" ocaModels={ocaModels} onRefresh={vi.fn()} />)

		expect(screen.getByTestId("model-id")).toHaveDisplayValue("No model selected")
		expect(screen.getByRole("status")).toHaveTextContent("No model selected.")
		expect(screen.queryByText(/Context:/)).not.toBeInTheDocument()
	})

	it.each(["plan", "act"] as const)("writes a model chosen on the %s tab to that tab's own slot", async (tab) => {
		render(<OcaModelPicker apiConfiguration={{}} currentMode={tab} ocaModels={ocaModels} onRefresh={vi.fn()} />)

		fireEvent.change(screen.getByTestId("model-id"), { target: { value: "model-a" } })

		await waitFor(() =>
			expect(mocks.handleModeFieldsChange).toHaveBeenCalledWith(
				expect.objectContaining({ ocaModelId: { plan: "planModeOcaModelId", act: "actModeOcaModelId" } }),
				expect.objectContaining({ ocaModelId: "model-a" }),
				tab,
			),
		)
	})
})

describe("the Bedrock picker with an empty slot", () => {
	beforeEach(() => mocks.commitSelection.mockClear())

	it("shows No model selected, not the catalog default", () => {
		render(<BedrockProvider currentMode="plan" showModelOptions={true} />)

		expect(screen.getByTestId("bedrock-model-dropdown")).toHaveDisplayValue("No model selected")
		expect(screen.queryByText(/Context:/)).not.toBeInTheDocument()
	})

	it.each(["plan", "act"] as const)("writes a model chosen on the %s tab to that tab's own slot", async (tab) => {
		render(<BedrockProvider currentMode={tab} showModelOptions={true} />)

		fireEvent.change(screen.getByTestId("bedrock-model-dropdown"), { target: { value: "model-a" } })

		await waitFor(() =>
			expect(mocks.commitSelection).toHaveBeenCalledWith(tab, expect.objectContaining({ modelId: "model-a" })),
		)
	})
})
