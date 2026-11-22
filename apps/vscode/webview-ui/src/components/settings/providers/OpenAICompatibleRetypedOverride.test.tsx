import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OpenAICompatibleProvider } from "./OpenAICompatible"

const mocks = vi.hoisted(() => ({
	commitSelection: vi.fn(),
	handleFieldChange: vi.fn(),
	handleModeFieldChange: vi.fn(),
	refreshOpenAiModels: vi.fn(),
	useDynamicProviderSelection: vi.fn(),
	useExtensionState: vi.fn(),
	useProviderConfig: vi.fn(),
	write: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: mocks.useExtensionState,
}))

vi.mock("@/hooks/useDynamicProviderSelection", () => ({
	useDynamicProviderSelection: mocks.useDynamicProviderSelection,
}))

vi.mock("@/hooks/useProviderConfig", () => ({
	fromProtobufProviderModelOverrides: (overrides: Record<string, unknown> | undefined) =>
		overrides ? { ...overrides } : undefined,
	useProviderConfig: mocks.useProviderConfig,
}))

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: {
		refreshOpenAiModels: mocks.refreshOpenAiModels,
	},
}))

vi.mock("../utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({
		handleFieldChange: mocks.handleFieldChange,
		handleModeFieldChange: mocks.handleModeFieldChange,
	}),
}))

vi.mock("@radix-ui/react-tooltip", () => ({
	TooltipContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	TooltipTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))

// DebouncedTextField is deliberately NOT mocked here. Its debounced save is the
// subject of these tests, and only the real field (useDebouncedInput) shows
// whether a save is a user edit or a field echo.
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, disabled, onClick }: { children?: React.ReactNode; disabled?: boolean; onClick?: () => void }) => (
		<button disabled={disabled} onClick={onClick} type="button">
			{children}
		</button>
	),
	VSCodeCheckbox: ({
		checked,
		children,
		onChange,
	}: {
		checked?: boolean
		children?: React.ReactNode
		onChange?: (event: { target: { checked: boolean } }) => void
	}) => (
		<label>
			<input checked={checked} onChange={onChange} type="checkbox" />
			{children}
		</label>
	),
	VSCodeDropdown: ({
		children,
		id,
		onChange,
		value,
		"aria-label": ariaLabel,
	}: {
		children?: React.ReactNode
		id?: string
		onChange?: (event: { target: { value: string } }) => void
		value?: string
		"aria-label"?: string
	}) => (
		<select aria-label={ariaLabel} id={id} onChange={onChange} value={value}>
			{children}
		</select>
	),
	VSCodeOption: ({ children, value }: { children?: React.ReactNode; value?: string }) => (
		<option value={value}>{children}</option>
	),
	VSCodeLink: ({ children }: { children?: React.ReactNode }) => <a href="https://example.com">{children}</a>,
	VSCodeTextField: ({
		children,
		onInput,
		value,
	}: {
		children?: React.ReactNode
		onInput?: (event: { target: { value: string } }) => void
		value?: string
	}) => (
		<label>
			{children}
			<input onChange={(event) => onInput?.({ target: { value: event.target.value } })} value={value ?? ""} />
		</label>
	),
}))

vi.mock("../common/ApiKeyField", () => ({
	ApiKeyField: ({
		initialValue,
		onChange,
		providerName,
	}: {
		initialValue?: string
		onChange: (value: string) => void
		providerName: string
	}) => (
		<input
			aria-label={`${providerName} API key`}
			onChange={(event) => onChange(event.target.value)}
			value={initialValue ?? ""}
		/>
	),
}))

vi.mock("../common/BaseUrlField", () => ({
	BaseUrlField: ({
		initialValue,
		label,
		onChange,
	}: {
		initialValue?: string
		label: string
		onChange: (value: string) => void
	}) => (
		<label>
			{label}
			<input aria-label={label} onChange={(event) => onChange(event.target.value)} value={initialValue ?? ""} />
		</label>
	),
}))

vi.mock("../common/ModelInfoView", () => ({ ModelInfoView: () => null }))
vi.mock("../ReasoningEffortSelector", () => ({ default: () => null }))

function renderProvider() {
	return render(<OpenAICompatibleProvider currentMode="act" providerId="custom-openai" showModelOptions={false} />)
}

function setCommittedSelection(overrides: Record<string, unknown>) {
	mocks.useProviderConfig.mockReturnValue({
		config: {
			actSelection: {
				modelId: "custom-model",
				modelInfo: {
					contextWindow: 128_000,
					inputPrice: 0,
					maxTokens: -1,
					outputPrice: 0,
					temperature: 0,
					tiers: [],
				},
				overrides,
				providerId: "custom-openai",
			},
			apiKeyLength: 12,
			baseUrl: "http://localhost:1234/v1",
			headers: {},
			providerId: "custom-openai",
		},
		commitSelection: mocks.commitSelection,
		write: mocks.write,
	})
}

describe("OpenAICompatibleProvider model configuration fields", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.clearAllMocks()
		mocks.commitSelection.mockResolvedValue(undefined)
		mocks.write.mockResolvedValue(undefined)
		mocks.refreshOpenAiModels.mockResolvedValue({ values: ["custom-model"] })
		mocks.useExtensionState.mockReturnValue({
			apiConfiguration: { azureApiVersion: "2025-04-01-preview", azureIdentity: false },
			remoteConfigSettings: undefined,
		})
		mocks.useDynamicProviderSelection.mockReturnValue({
			selectedModelId: "custom-model",
			selectedModelInfo: {
				contextWindow: 128_000,
				inputPrice: 0,
				maxTokens: -1,
				outputPrice: 0,
				temperature: 0,
			},
		})
		setCommittedSelection({})
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	// A field mounts showing the resolved value of the model, and switching
	// models or modes resyncs it to another one. Neither may be written back as
	// though the user had authored it - that pins catalog numbers as overrides.
	it("does not save the value a field mounts with", async () => {
		renderProvider()
		await act(async () => {
			fireEvent.click(screen.getByText("Model Configuration"))
			vi.advanceTimersByTime(1_000)
		})

		expect(mocks.commitSelection).not.toHaveBeenCalled()
	})

	// The other half. A user who selects the field and retypes the same number
	// passes through values that differ from it, and the last keystroke lands
	// back on the displayed value. That final edit is a real edit, and it used to
	// be discarded as if it had been a field echo.
	it("saves a context window retyped back to the value already displayed", async () => {
		renderProvider()
		await act(async () => {
			fireEvent.click(screen.getByText("Model Configuration"))
		})

		const input = screen.getByLabelText("Context Window Size")
		await act(async () => {
			fireEvent.change(input, { target: { value: "1280001" } })
			fireEvent.change(input, { target: { value: "128000" } })
			vi.advanceTimersByTime(1_000)
		})

		expect(mocks.commitSelection).toHaveBeenCalledWith("act", {
			providerId: "custom-openai",
			modelId: "custom-model",
			overrides: { contextWindow: 128_000 },
		})
	})

	// And the edit itself must still land when it differs from what is shown.
	it("saves an edit typed into a field showing another value", async () => {
		renderProvider()
		await act(async () => {
			fireEvent.click(screen.getByText("Model Configuration"))
		})

		const input = screen.getByLabelText("Context Window Size")
		await act(async () => {
			fireEvent.change(input, { target: { value: "262144" } })
			vi.advanceTimersByTime(1_000)
		})

		expect(mocks.commitSelection).toHaveBeenCalledWith("act", {
			providerId: "custom-openai",
			modelId: "custom-model",
			overrides: { contextWindow: 262_144 },
		})
	})
})
