import { ApiFormat } from "@shared/proto/cline/models"
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useProviderModelSelection } from "./useProviderModelSelection"

describe("useProviderModelSelection", () => {
	it("does not turn custom fallback model info into persisted overrides", async () => {
		const commitSelection = vi.fn(async () => undefined)
		const customModelInfo = {
			name: "Custom model",
			contextWindow: 128_000,
			maxTokens: -1,
			inputPrice: 0,
			outputPrice: 0,
			temperature: 0,
		}
		const { result } = renderHook(() =>
			useProviderModelSelection("custom-provider", "act", {
				models: {},
				commitSelection,
				customModelInfo: () => customModelInfo,
			}),
		)

		await act(async () => {
			await result.current.commitModelSelection({ modelId: "custom-model", modelInfo: customModelInfo })
		})

		expect(commitSelection).toHaveBeenCalledWith("act", {
			providerId: "custom-provider",
			modelId: "custom-model",
		})
	})

	it("forwards only explicitly supplied overrides", async () => {
		const commitSelection = vi.fn(async () => undefined)
		const { result } = renderHook(() =>
			useProviderModelSelection("custom-provider", "act", {
				models: {},
				commitSelection,
			}),
		)

		await act(async () => {
			await result.current.commitModelSelection({
				modelId: "custom-model",
				modelInfo: { contextWindow: 128_000, maxTokens: -1, temperature: -1 },
				overrides: {
					apiFormat: ApiFormat.OPENAI_RESPONSES,
					capabilities: ["tools", "streaming"],
					temperature: 0.2,
				},
			})
		})

		expect(commitSelection).toHaveBeenCalledWith("act", {
			providerId: "custom-provider",
			modelId: "custom-model",
			overrides: {
				apiFormat: ApiFormat.OPENAI_RESPONSES,
				capabilities: ["tools", "streaming"],
				temperature: 0.2,
			},
		})
	})

	it("applies an override to the model on screen when the caller supplies no model id", async () => {
		// Every catalog-backed provider commits through here. A selection with no
		// model id must not reach the host as one: the host writes the incoming
		// id over the stored selection, so a blank id blanks the model.
		const commitSelection = vi.fn(async () => undefined)
		const { result } = renderHook(() =>
			useProviderModelSelection("groq", "act", {
				commitSelection,
				config: { actSelection: { modelId: "llama-3.3-70b-versatile" } } as never,
				models: {
					"llama-3.3-70b-versatile": { contextWindow: 128_000, maxTokens: 8_192, supportsPromptCache: false },
					"mixtral-8x7b": { contextWindow: 32_768, maxTokens: 4_096, supportsPromptCache: false },
				},
			}),
		)

		await act(async () => {
			await result.current.commitModelSelection({ modelId: "   ", overrides: { contextWindow: 262_144 } })
		})

		expect(commitSelection).toHaveBeenCalledWith("act", {
			providerId: "groq",
			modelId: "llama-3.3-70b-versatile",
			overrides: { contextWindow: 262_144 },
		})
	})
})
