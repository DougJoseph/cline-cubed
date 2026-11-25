import { fireEvent, render, screen } from "@testing-library/react"
import type { ComponentType } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import BasetenModelPicker from "./BasetenModelPicker"
import GroqModelPicker from "./GroqModelPicker"
import HicapModelPicker from "./HicapModelPicker"
import { HuggingFaceModelPicker } from "./HuggingFaceModelPicker"
import OpenRouterModelPicker from "./OpenRouterModelPicker"
import RequestyModelPicker from "./RequestyModelPicker"
import VercelModelPicker from "./VercelModelPicker"

/**
 * Cline Cubed: each search picker shows an empty model slot as empty, never the provider's
 * catalog default, and a model chosen on a tab is written to that tab's own slot. Pickers
 * that show model details only for a recognized model (`showsDetails: false`) show an empty
 * search box and no details; Hugging Face's details panel says "No model selected."
 */

const mocks = vi.hoisted(() => ({
	handleModeFieldsChange: vi.fn(async () => undefined),
	commitSelection: vi.fn(async () => undefined),
	write: vi.fn(async () => undefined),
}))

const info = { name: "Model A", contextWindow: 100_000, supportsPromptCache: false, maxTokens: 4_096 }
const models = { "model-a": info, "catalog-default": { ...info, name: "Default" } }

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		apiConfiguration: {},
		favoritedModelIds: [],
		basetenModels: models,
		groqModels: models,
		huggingFaceModels: models,
		requestyModels: models,
		openRouterModels: models,
		vercelAiGatewayModels: models,
		hicapModels: models,
		setGroqModels: vi.fn(),
		setHuggingFaceModels: vi.fn(),
		setRequestyModels: vi.fn(),
		refreshOpenRouterModels: vi.fn(),
		refreshVercelAiGatewayModels: vi.fn(),
		refreshHicapModels: vi.fn(),
	}),
}))

vi.mock("@/hooks/useProviderModels", () => ({
	useProviderModels: () => ({
		models,
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

vi.mock("./utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({
		handleFieldChange: vi.fn(async () => undefined),
		handleFieldsChange: vi.fn(async () => undefined),
		handleModeFieldChange: vi.fn(async () => undefined),
		handleModeFieldsChange: mocks.handleModeFieldsChange,
	}),
}))

vi.mock("@/services/grpc-client", () => {
	const client = new Proxy({}, { get: () => vi.fn(async () => ({})) })
	return {
		ModelsServiceClient: client,
		StateServiceClient: client,
		UiServiceClient: client,
		AccountServiceClient: client,
	}
})

type Picker = ComponentType<{ currentMode: "plan" | "act"; isPopup?: boolean }>

const pickers: Array<{ name: string; Picker: Picker; placeholder: string; showsDetails: boolean }> = [
	{ name: "Baseten", Picker: BasetenModelPicker, placeholder: "Search and select a model...", showsDetails: false },
	{ name: "Groq", Picker: GroqModelPicker, placeholder: "Search and select a model...", showsDetails: false },
	{ name: "Hugging Face", Picker: HuggingFaceModelPicker as Picker, placeholder: "Search models...", showsDetails: true },
	{ name: "Requesty", Picker: RequestyModelPicker, placeholder: "Search and select a model...", showsDetails: false },
	{ name: "OpenRouter", Picker: OpenRouterModelPicker, placeholder: "Search and select a model...", showsDetails: false },
	{ name: "Vercel", Picker: VercelModelPicker, placeholder: "Search and select a model...", showsDetails: false },
	{ name: "Hicap", Picker: HicapModelPicker, placeholder: "Search and select a model...", showsDetails: false },
]

/** Whether a handleModeFieldsChange call wrote `modelId` to the given tab's own slot. */
function wroteToTab(modelId: string, tab: "plan" | "act"): boolean {
	return mocks.handleModeFieldsChange.mock.calls.some((call) => {
		const [mapping, values, mode] = call as unknown as [
			Record<string, Record<string, string>>,
			Record<string, unknown>,
			string,
		]
		return (
			mode === tab &&
			Object.values(values).includes(modelId) &&
			Object.values(mapping).some((keys) => keys[tab]?.startsWith(`${tab}Mode`))
		)
	})
}

describe.each(pickers)("the $name picker with an empty slot", ({ Picker, placeholder, showsDetails }) => {
	beforeEach(() => {
		mocks.handleModeFieldsChange.mockClear()
		mocks.commitSelection.mockClear()
	})

	it("shows no model, not the catalog default", () => {
		render(<Picker currentMode="plan" />)

		expect(screen.getByPlaceholderText(placeholder)).toHaveValue("")
		if (showsDetails) {
			expect(screen.getByRole("status")).toHaveTextContent("No model selected.")
		}
		// No details of any model, the catalog default above all, until one is chosen.
		expect(screen.queryByText(/Context:/)).not.toBeInTheDocument()
		expect(screen.queryByText(/catalog-default/)).not.toBeInTheDocument()
	})

	it.each(["plan", "act"] as const)("writes a model chosen on the %s tab to that tab's own slot", (tab) => {
		render(<Picker currentMode={tab} />)

		fireEvent.focus(screen.getByPlaceholderText(placeholder))
		fireEvent.click(screen.getByText("model-a"))

		expect(wroteToTab("model-a", tab)).toBe(true)
	})
})
