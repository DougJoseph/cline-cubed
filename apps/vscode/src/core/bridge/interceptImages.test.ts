import type { ApiConfiguration } from "@shared/api"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ProviderConfigStore } from "@/sdk/model-catalog/contracts"

/**
 * Cline Cubed: the image bridge lets a text-only reasoning model understand a pasted image — the
 * Image Mode model describes it, and the description is sent in the image's place. Two rules
 * decide whether and how that happens, and both are invisible when they go wrong:
 *
 * THE CAPABILITY GATE. The bridge runs only when the model actually doing the work cannot see
 * images. A vision-capable Plan/Act model must receive the raw image, since its own understanding
 * beats a paraphrase; a model whose capability is unknown is treated as text-only, so the bridge
 * still helps. Break the gate one way and a vision model is quietly downgraded to reading someone
 * else's description of the picture; break it the other and a text-only model is handed bytes it
 * cannot read.
 *
 * PROVIDER-SCOPED CREDENTIALS. The Image tab writes its key and base URL under the PROVIDER
 * (`deepSeekApiKey`, say), not into the generic `imageModeApi*` slots, so the bridge reads them
 * from the provider config store — scoped to the IMAGE provider, never the Plan/Act one. Read the
 * wrong scope and the call goes out with no Authorization header, or with another provider's key.
 * Reasoning effort rides along only for a model the catalog KNOWS supports reasoning, so a custom
 * id is never rejected for a parameter it does not accept.
 */

const bridgeImage = vi.fn()

vi.mock("./imageBridge", () => ({
	bridgeImage: (...args: unknown[]) => bridgeImage(...args),
}))

vi.mock("./bridgeDebug", () => ({
	beginBridgeSubmission: vi.fn(),
	recordBridgeDebug: vi.fn(),
}))

const PNG = "data:image/png;base64,aGVsbG8="

/** A configuration with Plan and Act on one provider and Image Mode on another. */
function configuration(overrides: Partial<ApiConfiguration> = {}): ApiConfiguration {
	return {
		planModeApiProvider: "anthropic",
		actModeApiProvider: "anthropic",
		planModeApiModelId: "claude-sonnet-4.5",
		actModeApiModelId: "claude-sonnet-4.5",
		imageModeApiProvider: "deepseek",
		imageModeApiModelId: "deepseek-v4-flash-vision-exp",
		...overrides,
	} as ApiConfiguration
}

/**
 * A provider store answering per provider and mode. `selections` is keyed
 * "<provider>:<mode>"; `configs` by provider.
 */
function makeStore(
	selections: Record<string, { modelId: string; supportsImages?: boolean; supportsReasoning?: boolean }>,
	configs: Record<string, { apiKey?: string; baseUrl?: string }> = {},
): ProviderConfigStore {
	return {
		read: vi.fn((providerId: unknown) => ({
			providerId,
			...(configs[String(providerId)] ?? {}),
		})),
		readSelection: vi.fn((providerId: unknown, mode: unknown) => {
			const entry = selections[`${String(providerId)}:${String(mode)}`]
			if (!entry) {
				return undefined
			}
			return {
				providerId,
				modelId: entry.modelId,
				modelInfo: {
					name: entry.modelId,
					supportsPromptCache: false,
					contextWindow: 128_000,
					supportsImages: entry.supportsImages,
					supportsReasoning: entry.supportsReasoning,
				},
			}
		}),
		subscribe: vi.fn(() => ({ dispose: vi.fn() })),
		write: vi.fn(),
		commitSelection: vi.fn(),
	} as unknown as ProviderConfigStore
}

/** What the bridge was called with, or undefined when it was never called. */
function bridgeCall(): Record<string, unknown> | undefined {
	return bridgeImage.mock.calls[0]?.[0] as Record<string, unknown> | undefined
}

beforeEach(() => {
	vi.clearAllMocks()
	bridgeImage.mockResolvedValue("a screenshot of a login form")
})

describe("interceptImagesForNonVisionModel — the capability gate", () => {
	it("does NOT bridge when the active Act model can see images", async () => {
		const { interceptImagesForNonVisionModel } = await import("./interceptImages")
		const store = makeStore({
			"anthropic:act": { modelId: "claude-sonnet-4.5", supportsImages: true },
			"deepseek:image": { modelId: "deepseek-v4-flash-vision-exp" },
		})

		const result = await interceptImagesForNonVisionModel({
			text: "look at this",
			images: [PNG],
			apiConfiguration: configuration(),
			providerConfigStore: store,
			mode: "act",
		})

		expect(bridgeImage).not.toHaveBeenCalled()
		expect(result.images).toEqual([PNG])
		expect(result.text).toBe("look at this")
		expect(result.bridgedCount).toBe(0)
	})

	it("bridges when the active Act model cannot see images", async () => {
		const { interceptImagesForNonVisionModel } = await import("./interceptImages")
		const store = makeStore({
			"anthropic:act": { modelId: "text-only-model", supportsImages: false },
			"deepseek:image": { modelId: "deepseek-v4-flash-vision-exp" },
		})

		const result = await interceptImagesForNonVisionModel({
			text: "look at this",
			images: [PNG],
			apiConfiguration: configuration(),
			providerConfigStore: store,
			mode: "act",
		})

		expect(bridgeImage).toHaveBeenCalledTimes(1)
		expect(result.images).toEqual([])
		expect(result.text).toContain("a screenshot of a login form")
		expect(result.bridgedCount).toBe(1)
	})

	it("bridges when the active model's capability is UNKNOWN", async () => {
		const { interceptImagesForNonVisionModel } = await import("./interceptImages")
		const store = makeStore({
			"anthropic:act": { modelId: "some-custom-model" },
			"deepseek:image": { modelId: "deepseek-v4-flash-vision-exp" },
		})

		const result = await interceptImagesForNonVisionModel({
			text: "look at this",
			images: [PNG],
			apiConfiguration: configuration(),
			providerConfigStore: store,
			mode: "act",
		})

		expect(bridgeImage).toHaveBeenCalledTimes(1)
		expect(result.bridgedCount).toBe(1)
	})

	it("gates on the mode actually in use — a vision PLAN model is not bridged for", async () => {
		const { interceptImagesForNonVisionModel } = await import("./interceptImages")
		const store = makeStore({
			"anthropic:plan": { modelId: "claude-sonnet-4.5", supportsImages: true },
			"anthropic:act": { modelId: "text-only-model", supportsImages: false },
			"deepseek:image": { modelId: "deepseek-v4-flash-vision-exp" },
		})

		const result = await interceptImagesForNonVisionModel({
			text: "look at this",
			images: [PNG],
			apiConfiguration: configuration(),
			providerConfigStore: store,
			mode: "plan",
		})

		expect(bridgeImage).not.toHaveBeenCalled()
		expect(result.images).toEqual([PNG])
	})

	it("bridges anyway when the gate cannot be resolved", async () => {
		const { interceptImagesForNonVisionModel } = await import("./interceptImages")
		const store = makeStore({ "deepseek:image": { modelId: "deepseek-v4-flash-vision-exp" } })
		vi.mocked(store.readSelection).mockImplementation((_providerId: unknown, mode: unknown) => {
			if (String(mode) === "act") {
				throw new Error("store unavailable")
			}
			return undefined
		})

		const result = await interceptImagesForNonVisionModel({
			text: "look at this",
			images: [PNG],
			apiConfiguration: configuration(),
			providerConfigStore: store,
			mode: "act",
		})

		expect(bridgeImage).toHaveBeenCalledTimes(1)
		expect(result.bridgedCount).toBe(1)
	})

	it("does nothing without images, and nothing without an Image Mode model", async () => {
		const { interceptImagesForNonVisionModel } = await import("./interceptImages")
		const store = makeStore({ "anthropic:act": { modelId: "text-only-model", supportsImages: false } })

		const noImages = await interceptImagesForNonVisionModel({
			text: "hello",
			images: [],
			apiConfiguration: configuration(),
			providerConfigStore: store,
			mode: "act",
		})
		expect(noImages).toEqual({ text: "hello", images: [], bridgedCount: 0 })

		// Image Mode unconfigured means no provider AND no model: with a provider still set, the
		// id falls through to that provider's default, so there IS a model and bridging is right.
		const noImageModel = await interceptImagesForNonVisionModel({
			text: "hello",
			images: [PNG],
			apiConfiguration: configuration({ imageModeApiProvider: undefined, imageModeApiModelId: undefined }),
			providerConfigStore: store,
			mode: "act",
		})
		expect(bridgeImage).not.toHaveBeenCalled()
		expect(noImageModel.images).toEqual([PNG])
	})
})

describe("interceptImagesForNonVisionModel — provider-scoped credentials", () => {
	it("takes the key and base URL from the IMAGE provider, not the Plan/Act one", async () => {
		const { interceptImagesForNonVisionModel } = await import("./interceptImages")
		const store = makeStore(
			{
				"anthropic:act": { modelId: "text-only-model", supportsImages: false },
				"deepseek:image": { modelId: "deepseek-v4-flash-vision-exp" },
			},
			{
				anthropic: { apiKey: "anthropic-key", baseUrl: "https://api.anthropic.com" },
				deepseek: { apiKey: "deepseek-key", baseUrl: "https://api.deepseek.com" },
			},
		)

		await interceptImagesForNonVisionModel({
			text: "look",
			images: [PNG],
			apiConfiguration: configuration(),
			providerConfigStore: store,
			mode: "act",
		})

		const call = bridgeCall()
		expect(call?.provider).toBe("deepseek")
		expect(call?.apiKey).toBe("deepseek-key")
		expect(call?.apiUri).toBe("https://api.deepseek.com")
		expect(call?.modelId).toBe("deepseek-v4-flash-vision-exp")
	})

	it("prefers an explicit imageModeApiKey over the provider-scoped one", async () => {
		const { interceptImagesForNonVisionModel } = await import("./interceptImages")
		const store = makeStore(
			{
				"anthropic:act": { modelId: "text-only-model", supportsImages: false },
				"deepseek:image": { modelId: "deepseek-v4-flash-vision-exp" },
			},
			{ deepseek: { apiKey: "deepseek-key" } },
		)

		await interceptImagesForNonVisionModel({
			text: "look",
			images: [PNG],
			apiConfiguration: configuration({ imageModeApiKey: "explicit-key" }),
			providerConfigStore: store,
			mode: "act",
		})

		expect(bridgeCall()?.apiKey).toBe("explicit-key")
	})

	it("sends reasoning effort only for an image model KNOWN to support reasoning", async () => {
		const { interceptImagesForNonVisionModel } = await import("./interceptImages")
		const gate = { modelId: "text-only-model", supportsImages: false }

		await interceptImagesForNonVisionModel({
			text: "look",
			images: [PNG],
			apiConfiguration: configuration({ imageModeReasoningEffort: "high" } as Partial<ApiConfiguration>),
			providerConfigStore: makeStore({
				"anthropic:act": gate,
				"deepseek:image": { modelId: "deepseek-v4-flash-vision-exp", supportsReasoning: true },
			}),
			mode: "act",
		})
		expect(bridgeCall()?.reasoningEffort).toBe("high")

		bridgeImage.mockClear()
		await interceptImagesForNonVisionModel({
			text: "look",
			images: [PNG],
			apiConfiguration: configuration({ imageModeReasoningEffort: "high" } as Partial<ApiConfiguration>),
			providerConfigStore: makeStore({
				"anthropic:act": gate,
				"deepseek:image": { modelId: "my-own-vision-model" },
			}),
			mode: "act",
		})
		expect(bridgeCall()?.reasoningEffort).toBeUndefined()
	})

	it("keeps the image in the conversation when the bridge call fails", async () => {
		const { interceptImagesForNonVisionModel } = await import("./interceptImages")
		bridgeImage.mockRejectedValue(new Error("402 payment required"))

		const result = await interceptImagesForNonVisionModel({
			text: "look",
			images: [PNG],
			apiConfiguration: configuration(),
			providerConfigStore: makeStore({
				"anthropic:act": { modelId: "text-only-model", supportsImages: false },
				"deepseek:image": { modelId: "deepseek-v4-flash-vision-exp" },
			}),
			mode: "act",
		})

		expect(result.text).toContain("Image bridge failed: 402 payment required")
		expect(result.bridgedCount).toBe(1)
	})
})
