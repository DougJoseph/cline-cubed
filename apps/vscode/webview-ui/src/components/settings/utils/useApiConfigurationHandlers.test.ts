import { UpdateApiConfigurationRequest } from "@shared/proto/cline/models"
import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"
import { useApiConfigurationHandlers } from "./useApiConfigurationHandlers"

/**
 * Cline Cubed: Image Mode is a THIRD channel beside Plan and Act, and it has no plan/act split —
 * one provider, one model, one reasoning effort. Every settings control on that tab is the same
 * component the Plan and Act tabs use, so each change arrives here as a plan/act FIELD PAIR that
 * must be routed to its single image-mode home. Route one wrongly and a change made on the Image
 * tab silently rewrites the model the person's real work runs on.
 *
 * These tests pin the routing table: the provider pair → `imageModeApiProvider`, any `*ModelId`
 * pair → `imageModeApiModelId`, the reasoning-effort pair → `imageModeReasoningEffort`, and
 * everything else (model info, thinking budgets) has no image-mode home and must write nothing.
 */

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: {
		updateApiConfigurationProto: vi.fn(),
	},
}))

const mockUseExtensionState = vi.mocked(useExtensionState)
const mockUpdate = vi.mocked(ModelsServiceClient.updateApiConfigurationProto)

/** The configuration every test starts from: Plan and Act on a real model, Image Mode unset. */
const BASE_CONFIG = {
	planModeApiProvider: "anthropic",
	actModeApiProvider: "anthropic",
	planModeApiModelId: "claude-sonnet-4.5",
	actModeApiModelId: "claude-sonnet-4.5",
}

function renderHandlers(planActSeparateModelsSetting = false) {
	mockUseExtensionState.mockReturnValue({
		apiConfiguration: { ...BASE_CONFIG },
		planActSeparateModelsSetting,
	} as ReturnType<typeof useExtensionState>)
	return renderHook(() => useApiConfigurationHandlers()).result.current
}

/** The configuration the hook actually sent, or undefined when it sent nothing. */
function sentConfiguration(): Record<string, unknown> | undefined {
	if (mockUpdate.mock.calls.length === 0) {
		return undefined
	}
	const request = mockUpdate.mock.calls[0][0] as ReturnType<typeof UpdateApiConfigurationRequest.create>
	return request.apiConfiguration as unknown as Record<string, unknown>
}

beforeEach(() => {
	vi.clearAllMocks()
	mockUpdate.mockResolvedValue(undefined as never)
})

describe("useApiConfigurationHandlers — Image Mode routing (handleModeFieldChange)", () => {
	it("routes the provider pair to imageModeApiProvider, and leaves Plan and Act alone", async () => {
		const { handleModeFieldChange } = renderHandlers()

		await handleModeFieldChange({ plan: "planModeApiProvider", act: "actModeApiProvider" }, "openai-native" as never, "image")

		const sent = sentConfiguration()
		expect(sent?.imageModeApiProvider).toBe("openai-native")
		expect(sent?.planModeApiProvider).toBe("anthropic")
		expect(sent?.actModeApiProvider).toBe("anthropic")
	})

	it("routes a model-id pair to imageModeApiModelId, and leaves Plan and Act alone", async () => {
		const { handleModeFieldChange } = renderHandlers()

		await handleModeFieldChange({ plan: "planModeApiModelId", act: "actModeApiModelId" }, "gpt-5.4-vision" as never, "image")

		const sent = sentConfiguration()
		expect(sent?.imageModeApiModelId).toBe("gpt-5.4-vision")
		expect(sent?.planModeApiModelId).toBe("claude-sonnet-4.5")
		expect(sent?.actModeApiModelId).toBe("claude-sonnet-4.5")
	})

	it("routes a provider-specific model-id pair to imageModeApiModelId as well", async () => {
		const { handleModeFieldChange } = renderHandlers()

		await handleModeFieldChange(
			{ plan: "planModeOpenRouterModelId", act: "actModeOpenRouterModelId" },
			"qwen/qwen3-vl" as never,
			"image",
		)

		expect(sentConfiguration()?.imageModeApiModelId).toBe("qwen/qwen3-vl")
	})

	it("routes the reasoning-effort pair to imageModeReasoningEffort", async () => {
		const { handleModeFieldChange } = renderHandlers()

		await handleModeFieldChange({ plan: "planModeReasoningEffort", act: "actModeReasoningEffort" }, "high" as never, "image")

		// The proto carries this one under `imageModeApiReasoningEffort` — the extension-side
		// field is `imageModeReasoningEffort`, and the conversion renames it on the way out.
		expect(sentConfiguration()?.imageModeApiReasoningEffort).toBe("high")
	})

	it("writes NOTHING for a pair with no image-mode home", async () => {
		const { handleModeFieldChange } = renderHandlers()

		await handleModeFieldChange(
			{ plan: "planModeThinkingBudgetTokens", act: "actModeThinkingBudgetTokens" },
			4096 as never,
			"image",
		)

		expect(mockUpdate).not.toHaveBeenCalled()
	})

	it("leaves Plan and Act mode untouched by the image routing", async () => {
		const { handleModeFieldChange } = renderHandlers(true)

		await handleModeFieldChange({ plan: "planModeApiProvider", act: "actModeApiProvider" }, "openai-native" as never, "plan")

		const sent = sentConfiguration()
		expect(sent?.planModeApiProvider).toBe("openai-native")
		expect(sent?.imageModeApiProvider).toBeFalsy()
	})
})

describe("useApiConfigurationHandlers — Image Mode routing (handleModeFieldsChange)", () => {
	it("maps several pairs onto their image-mode homes in ONE update", async () => {
		const { handleModeFieldsChange } = renderHandlers()

		await handleModeFieldsChange(
			{
				provider: { plan: "planModeApiProvider", act: "actModeApiProvider" },
				model: { plan: "planModeApiModelId", act: "actModeApiModelId" },
				effort: { plan: "planModeReasoningEffort", act: "actModeReasoningEffort" },
			},
			{ provider: "openai-native", model: "gpt-5.4-vision", effort: "medium" },
			"image",
		)

		expect(mockUpdate).toHaveBeenCalledTimes(1)
		const sent = sentConfiguration()
		expect(sent?.imageModeApiProvider).toBe("openai-native")
		expect(sent?.imageModeApiModelId).toBe("gpt-5.4-vision")
		expect(sent?.imageModeApiReasoningEffort).toBe("medium")
		expect(sent?.planModeApiProvider).toBe("anthropic")
		expect(sent?.actModeApiModelId).toBe("claude-sonnet-4.5")
	})

	it("drops the pairs with no image-mode home rather than writing them anywhere", async () => {
		const { handleModeFieldsChange } = renderHandlers()

		await handleModeFieldsChange(
			{
				model: { plan: "planModeApiModelId", act: "actModeApiModelId" },
				budget: { plan: "planModeThinkingBudgetTokens", act: "actModeThinkingBudgetTokens" },
			},
			{ model: "gpt-5.4-vision", budget: 4096 },
			"image",
		)

		const sent = sentConfiguration()
		expect(sent?.imageModeApiModelId).toBe("gpt-5.4-vision")
		expect(sent?.planModeThinkingBudgetTokens).toBeFalsy()
		expect(sent?.actModeThinkingBudgetTokens).toBeFalsy()
	})

	it("writes NOTHING when no pair has an image-mode home", async () => {
		const { handleModeFieldsChange } = renderHandlers()

		await handleModeFieldsChange(
			{ budget: { plan: "planModeThinkingBudgetTokens", act: "actModeThinkingBudgetTokens" } },
			{ budget: 4096 },
			"image",
		)

		expect(mockUpdate).not.toHaveBeenCalled()
	})
})
