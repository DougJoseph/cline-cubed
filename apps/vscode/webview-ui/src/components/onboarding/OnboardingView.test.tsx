import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import OnboardingView from "./OnboardingView"

const mocks = vi.hoisted(() => {
	const callOrder: string[] = []
	return {
		callOrder,
		accountLoginClicked: vi.fn(async () => {
			callOrder.push("accountLoginClicked")
		}),
		captureOnboardingProgress: vi.fn(async () => undefined),
		commitModelSelection: vi.fn(async () => {
			callOrder.push("commitModelSelection")
		}),
		commitSelection: vi.fn(async () => undefined),
		dismissOnboardingHere: vi.fn(),
		hideAccount: vi.fn(),
		hideSettings: vi.fn(),
		listProviders: vi.fn(async () => ({ providers: [] })),
		openUrl: vi.fn(async () => undefined),
		setWelcomeViewCompleted: vi.fn(async () => {
			callOrder.push("setWelcomeViewCompleted")
		}),
		setWelcomeView: vi.fn(),
		useExtensionState: vi.fn(),
		useOnboardingModels: vi.fn(),
		useProviderConfig: vi.fn(),
		useProviderModels: vi.fn(),
		write: vi.fn(async () => undefined),
	}
})

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: mocks.useExtensionState,
}))

vi.mock("@/hooks/useProviderConfig", () => ({
	fromProtobufProviderModelOverrides: (overrides: Record<string, unknown> | undefined) => overrides,
	useProviderConfig: mocks.useProviderConfig,
}))

vi.mock("@/hooks/useProviderModels", () => ({
	useProviderModels: mocks.useProviderModels,
}))

vi.mock("./useOnboardingModels", () => ({
	useOnboardingModels: mocks.useOnboardingModels,
}))

vi.mock("@/services/grpc-client", () => ({
	AccountServiceClient: { accountLoginClicked: mocks.accountLoginClicked },
	ModelsServiceClient: { commitModelSelection: mocks.commitModelSelection, listProviders: mocks.listProviders },
	StateServiceClient: {
		captureOnboardingProgress: mocks.captureOnboardingProgress,
		setWelcomeViewCompleted: mocks.setWelcomeViewCompleted,
	},
	UiServiceClient: { openUrl: mocks.openUrl },
}))

vi.mock("@/components/settings/utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({
		handleFieldChange: vi.fn(),
		handleFieldsChange: vi.fn(async () => undefined),
		handleModeFieldChange: vi.fn(),
	}),
}))

// The provider panel the BYOK step embeds. Its own behaviour is covered by the
// provider tests; here only the state it leaves behind matters.
vi.mock("../settings/sections/ApiConfigurationSection", () => ({
	default: () => <div data-testid="provider-config-panel" />,
}))
vi.mock("@/components/settings/NewChatLocationSetting", () => ({
	default: () => null,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children }: { children?: ReactNode }) => <a href="https://example.com">{children}</a>,
}))

/**
 * Walk the flow a first-run BYOK setup takes: choose "Bring my own API key",
 * configure the provider in the embedded panel, then Continue.
 *
 * `apiConfiguration` carries what the panel's own writes leave behind — the
 * provider for both modes and the model id picked in the picker.
 */
function renderByokProviderStep() {
	mocks.useExtensionState.mockReturnValue({
		apiConfiguration: {
			actModeApiProvider: "openai",
			actModeOpenAiModelId: "qwen3-coder",
			openAiApiKey: "local-key",
			openAiBaseUrl: "http://localhost:8000/v1",
			planActSeparateModelsSetting: true,
			planModeApiProvider: "openai",
			planModeOpenAiModelId: "qwen3-coder",
		},
		dismissOnboardingHere: mocks.dismissOnboardingHere,
		hideAccount: mocks.hideAccount,
		hideSettings: mocks.hideSettings,
		openRouterModels: {},
		setApiConfiguration: vi.fn(),
		setShowWelcome: mocks.setWelcomeView,
		updateApiConfigurationProp: vi.fn(),
		welcomeViewCompleted: false,
	})
	mocks.useProviderConfig.mockReturnValue({
		commitSelection: mocks.commitSelection,
		config: undefined,
		write: mocks.write,
	})
	mocks.useProviderModels.mockReturnValue({
		defaultModelId: undefined,
		error: undefined,
		isLoading: false,
		isStale: false,
		models: {},
	})
	mocks.useOnboardingModels.mockReturnValue({ models: { models: [] }, status: "success" })

	render(<OnboardingView />)

	fireEvent.click(screen.getByText("Bring my own API key"))
	fireEvent.click(screen.getByRole("button", { name: "Continue" }))
}

describe("OnboardingView BYOK completion", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.callOrder.length = 0
	})

	it("renders the provider configuration panel for the BYOK step", async () => {
		renderByokProviderStep()
		await act(async () => {})

		expect(screen.getByTestId("provider-config-panel")).toBeInTheDocument()
	})

	it("persists the model chosen in the provider panel before closing the welcome view", async () => {
		renderByokProviderStep()
		await act(async () => {})

		// The BYOK step's Continue button.
		fireEvent.click(screen.getByRole("button", { name: "Continue" }))
		await act(async () => {})

		expect(mocks.commitModelSelection).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "act",
				modelId: "qwen3-coder",
				providerId: "openai",
			}),
		)
		expect(mocks.callOrder.indexOf("commitModelSelection")).toBeLessThan(mocks.callOrder.indexOf("setWelcomeViewCompleted"))
	})
})
