import type { ApiConfiguration, ApiProvider } from "@shared/api"
import { getProviderModelIdKey } from "@shared/storage/provider-keys"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { normalizeProviderSwitchModel } from "@/core/controller/models/providerSwitchNormalization"
import { resolveActiveModelIdFromApiConfiguration } from "@/core/controller/models/taskApiModel"
import { resolveModelId } from "@/sdk/cline-session-factory"
import { parseProviderId } from "./provider-id"
import { toSdkProviderId } from "./sdk-provider-id"
import { createProviderConfigStore } from "./store"

const mocks = vi.hoisted(() => {
	let apiConfiguration: Record<string, unknown> = {}
	let providerSettings: Record<string, Record<string, unknown>> = {}
	return {
		reset() {
			apiConfiguration = {}
			providerSettings = {}
		},
		setConfig(value: Record<string, unknown>) {
			apiConfiguration = { ...value }
		},
		setProviderSettings(value: Record<string, Record<string, unknown>>) {
			providerSettings = value
		},
		stateManager() {
			return {
				getApiConfiguration: () => ({ ...apiConfiguration }),
				getGlobalSettingsKey: (key: string) => apiConfiguration[key],
				setGlobalState: (key: string, value: unknown) => {
					apiConfiguration = { ...apiConfiguration, [key]: value }
				},
				setGlobalStateBatch: (updates: Record<string, unknown>) => {
					apiConfiguration = { ...apiConfiguration, ...updates }
				},
				setSecret: vi.fn(),
			}
		},
		providerSettingsManager() {
			return {
				getProviderSettings: (id: string) => providerSettings[id],
				saveProviderSettings: vi.fn(),
			}
		},
	}
})

vi.mock("@/core/storage/StateManager", () => ({ StateManager: { get: mocks.stateManager } }))
vi.mock("@/services/logging/distinctId", () => ({ getDistinctId: () => "test" }))
vi.mock("@/sdk/provider-migration", () => ({ getProviderSettingsManager: mocks.providerSettingsManager }))
vi.mock("../provider-migration", () => ({ getProviderSettingsManager: mocks.providerSettingsManager }))

const ALL_PROVIDERS = [
	"anthropic",
	"claude-code",
	"openrouter",
	"bedrock",
	"vertex",
	"openai",
	"ollama",
	"lmstudio",
	"gemini",
	"openai-native",
	"openai-codex",
	"requesty",
	"together",
	"deepseek",
	"qwen",
	"qwen-code",
	"doubao",
	"mistral",
	"vscode-lm",
	"cline",
	"cline-pass",
	"litellm",
	"moonshot",
	"nebius",
	"fireworks",
	"asksage",
	"xai",
	"sambanova",
	"cerebras",
	"sapaicore",
	"groq",
	"poolside",
	"huggingface",
	"huawei-cloud-maas",
	"dify",
	"baseten",
	"vercel-ai-gateway",
	"v0",
	"zai",
	"zai-coding-plan",
	"oca",
	"aihubmix",
	"minimax",
	"hicap",
	"nousResearch",
	"wandb",
	"xiaomi",
	"tencent-tokenhub",
	"chutes",
] as const satisfies readonly ApiProvider[]

// A provider added to ApiProvider without a row here fails the typecheck.
const everyProviderIsListed: Exclude<ApiProvider, (typeof ALL_PROVIDERS)[number]> extends never ? true : never = true

const MODES = ["plan", "act", "image"] as const
const LOCAL_PROVIDERS = new Set<string>(["ollama", "lmstudio"])
const SELECTOR_PROVIDERS = new Set<string>(["vscode-lm"])
const providerField = { plan: "planModeApiProvider", act: "actModeApiProvider", image: "imageModeApiProvider" } as const

function activeConfig(provider: ApiProvider, mode: (typeof MODES)[number], extra: Record<string, unknown> = {}) {
	return { [providerField[mode]]: provider, ...extra }
}

describe("a mode's stored model, on every provider", () => {
	beforeEach(() => mocks.reset())

	it("covers all 49 providers", () => {
		expect(everyProviderIsListed).toBe(true)
		expect(new Set(ALL_PROVIDERS).size).toBe(49)
	})

	for (const provider of ALL_PROVIDERS) {
		for (const mode of MODES) {
			it(`${provider} ${mode}: an empty slot reports no model, whatever the provider-wide model is`, () => {
				mocks.setConfig(activeConfig(provider, mode))
				mocks.setProviderSettings({ [toSdkProviderId(provider)]: { model: "provider-wide-model" } })
				const selection = createProviderConfigStore().readSelection(parseProviderId(provider), mode)
				if (LOCAL_PROVIDERS.has(provider) && mode !== "image") {
					// The runtime reads the provider-wide model for these, so showing it is true.
					expect(selection?.modelId).toBe("provider-wide-model")
				} else {
					expect(selection).toBeUndefined()
				}
				expect(resolveActiveModelIdFromApiConfiguration(activeConfig(provider, mode) as ApiConfiguration, mode)).toBe(
					"unknown",
				)
			})

			if (!SELECTOR_PROVIDERS.has(provider)) {
				it(`${provider} ${mode}: a stored model is what Settings and the runtime both report`, () => {
					const key = getProviderModelIdKey(provider, mode)
					const config = activeConfig(provider, mode, { [key]: "my-own-custom-model" })
					mocks.setConfig(config)
					expect(createProviderConfigStore().readSelection(parseProviderId(provider), mode)?.modelId).toBe(
						"my-own-custom-model",
					)
					expect(resolveActiveModelIdFromApiConfiguration(config as ApiConfiguration, mode)).toBe("my-own-custom-model")
					if (mode !== "image") {
						expect(resolveModelId(provider, mode, config as ApiConfiguration)).toBe("my-own-custom-model")
					}
				})
			}
		}

		const sharedSlot = getProviderModelIdKey(provider, "plan") === "planModeApiModelId"
		if (sharedSlot && provider !== "deepseek" && !SELECTOR_PROVIDERS.has(provider)) {
			it(`${provider}: another provider's model in the shared slot counts as empty`, () => {
				const config = activeConfig(provider, "plan", { planModeApiModelId: "deepseek-reasoner" })
				mocks.setConfig(config)
				expect(createProviderConfigStore().readSelection(parseProviderId(provider), "plan")).toBeUndefined()
				expect(resolveModelId(provider, "plan", config as ApiConfiguration)).toBeUndefined()
				expect(resolveActiveModelIdFromApiConfiguration(config as ApiConfiguration, "plan")).toBe("unknown")
			})

			it(`${provider}: a foreign-looking id this provider itself saved stays`, () => {
				const config = activeConfig(provider, "plan", { planModeApiModelId: "deepseek-reasoner" })
				mocks.setConfig(config)
				mocks.setProviderSettings({ [toSdkProviderId(provider)]: { model: "deepseek-reasoner" } })
				expect(createProviderConfigStore().readSelection(parseProviderId(provider), "plan")?.modelId).toBe(
					"deepseek-reasoner",
				)
				expect(resolveModelId(provider, "plan", config as ApiConfiguration)).toBe("deepseek-reasoner")
			})
		}
	}

	it("SAP AI Core reads its own slot before a stale shared value", () => {
		const config = {
			planModeApiProvider: "sapaicore",
			planModeSapAiCoreModelId: "anthropic--claude-3.5-sonnet",
			planModeApiModelId: "deepseek-reasoner",
		} as ApiConfiguration
		expect(resolveModelId("sapaicore", "plan", config)).toBe("anthropic--claude-3.5-sonnet")
	})

	it("SAP AI Core does not use another provider's model from the shared slot", () => {
		const config = { planModeApiProvider: "sapaicore", planModeApiModelId: "deepseek-reasoner" } as ApiConfiguration
		expect(resolveModelId("sapaicore", "plan", config)).toBeUndefined()
	})
})

describe("switching a mode's provider", () => {
	beforeEach(() => mocks.reset())

	it("restores the new provider's own last model", () => {
		mocks.setProviderSettings({ gemini: { model: "my-gemini-choice" } })
		const previous = { planModeApiProvider: "deepseek", planModeApiModelId: "deepseek-reasoner" } as ApiConfiguration
		mocks.setConfig(previous as Record<string, unknown>)
		const next = normalizeProviderSwitchModel(createProviderConfigStore(), previous, {
			...previous,
			planModeApiProvider: "gemini",
		})
		expect(next.planModeApiModelId).toBe("my-gemini-choice")
	})

	it("clears the slot when the new provider has no model of its own, and writes no catalog default", () => {
		const previous = { planModeApiProvider: "deepseek", planModeApiModelId: "deepseek-reasoner" } as ApiConfiguration
		mocks.setConfig(previous as Record<string, unknown>)
		const next = normalizeProviderSwitchModel(createProviderConfigStore(), previous, {
			...previous,
			planModeApiProvider: "gemini",
		})
		expect(next.planModeApiModelId).toBeUndefined()
	})

	it("keeps a model named in the same update", () => {
		const previous = { planModeApiProvider: "deepseek", planModeApiModelId: "deepseek-reasoner" } as ApiConfiguration
		mocks.setConfig(previous as Record<string, unknown>)
		const next = normalizeProviderSwitchModel(createProviderConfigStore(), previous, {
			...previous,
			planModeApiProvider: "xai",
			planModeApiModelId: "typed-by-hand",
		})
		expect(next.planModeApiModelId).toBe("typed-by-hand")
	})

	it("clears the Image slot on an Image provider change instead of carrying the old provider's model", () => {
		const previous = {
			imageModeApiProvider: "deepseek",
			imageModeApiModelId: "deepseek-v4-flash-vision-exp",
		} as ApiConfiguration
		mocks.setConfig(previous as Record<string, unknown>)
		const next = normalizeProviderSwitchModel(createProviderConfigStore(), previous, {
			...previous,
			imageModeApiProvider: "gemini",
		})
		expect(next.imageModeApiModelId).toBeUndefined()
	})

	it("does not give Image the provider-wide model on an Image provider change", () => {
		mocks.setProviderSettings({ gemini: { model: "a-plan-model" } })
		const previous = {
			imageModeApiProvider: "deepseek",
			imageModeApiModelId: "deepseek-v4-flash-vision-exp",
		} as ApiConfiguration
		mocks.setConfig(previous as Record<string, unknown>)
		const next = normalizeProviderSwitchModel(createProviderConfigStore(), previous, {
			...previous,
			imageModeApiProvider: "gemini",
		})
		expect(next.imageModeApiModelId).toBeUndefined()
	})
})
