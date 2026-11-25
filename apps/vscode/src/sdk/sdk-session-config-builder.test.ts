import { describe, expect, it, vi } from "vitest"
import { SdkSessionConfigBuilder } from "./sdk-session-config-builder"

const mocks = vi.hoisted(() => ({
	buildSessionConfig: vi.fn(),
	buildAgentHooks: vi.fn(() => ({})),
}))

vi.mock("./cline-session-factory", () => ({
	buildSessionConfig: mocks.buildSessionConfig,
}))

vi.mock("./hooks-adapter", () => ({
	buildAgentHooks: mocks.buildAgentHooks,
}))

describe("SdkSessionConfigBuilder", () => {
	it("marks a session with no model so it can open but never send", async () => {
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {}, cwd: "/workspace", providerId: "gemini", modelId: "" })
		const builder = new SdkSessionConfigBuilder({
			stateManager: { getGlobalSettingsKey: vi.fn(() => undefined) } as never,
			emitHookMessage: vi.fn(),
		})

		expect((await builder.build({ cwd: "/workspace", mode: "plan" })).modelId).toBe("no-model-selected")
	})

	it("leaves Dify's model alone, because its application chooses one", async () => {
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {}, cwd: "/workspace", providerId: "dify", modelId: "default" })
		const builder = new SdkSessionConfigBuilder({
			stateManager: { getGlobalSettingsKey: vi.fn(() => undefined) } as never,
			emitHookMessage: vi.fn(),
		})

		expect((await builder.build({ cwd: "/workspace", mode: "plan" })).modelId).toBe("default")
	})

	it("never exposes a switch_to_act_mode tool, even in plan mode", async () => {
		// Matches the legacy extension: the model cannot switch plan -> act
		// itself; the user must flip the Plan/Act toggle.
		const builder = new SdkSessionConfigBuilder({
			stateManager: { getGlobalSettingsKey: vi.fn(() => undefined) } as never,
			emitHookMessage: vi.fn(),
		})

		mocks.buildSessionConfig.mockResolvedValueOnce({
			extraTools: [],
			hooks: {},
		})
		const planConfig = await builder.build({ cwd: "/workspace", mode: "plan" })
		expect(planConfig.extraTools?.some((tool) => tool.name === "switch_to_act_mode")).toBe(false)

		mocks.buildSessionConfig.mockResolvedValueOnce({
			extraTools: [],
			hooks: {},
		})
		const actConfig = await builder.build({ cwd: "/workspace", mode: "act" })
		expect(actConfig.extraTools?.some((tool) => tool.name === "switch_to_act_mode")).toBe(false)
	})

	it("wires the agent hooks into the SDK config", async () => {
		const hooks = { beforeModel: vi.fn() }
		mocks.buildAgentHooks.mockReturnValueOnce(hooks)
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {} })

		const builder = new SdkSessionConfigBuilder({
			stateManager: { getGlobalSettingsKey: vi.fn(() => undefined) } as never,
			emitHookMessage: vi.fn(),
		})

		const config = await builder.build({ cwd: "/workspace", mode: "act" })
		expect(config.hooks).toBe(hooks)
	})

	it("passes the mistake-limit callback into the SDK config without overriding SDK execution defaults", async () => {
		const onConsecutiveMistakeLimitReached = vi.fn()
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {}, execution: { maxRetries: 1 } })

		const builder = new SdkSessionConfigBuilder({
			stateManager: { getGlobalSettingsKey: vi.fn(() => 3) } as never,
			emitHookMessage: vi.fn(),
			onConsecutiveMistakeLimitReached,
		})

		const config = await builder.build({ cwd: "/workspace", mode: "act" })

		expect(config.execution).toEqual({ maxRetries: 1 })
		expect(config.onConsecutiveMistakeLimitReached).toBe(onConsecutiveMistakeLimitReached)
	})

	it("passes the Settings image limits to the engine and adds the image-descriptions extension", async () => {
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {}, providerId: "openai", modelId: "qwen" })
		const settings: Record<string, number> = {
			imagesTotalLimitMb: 20,
			imagesPerImageLimitMb: 7,
			imagesPerImageDecodedLimitMb: 9,
		}
		const builder = new SdkSessionConfigBuilder({
			stateManager: { getGlobalSettingsKey: vi.fn((key: string) => settings[key]) } as never,
			emitHookMessage: vi.fn(),
		})

		const config = await builder.build({ cwd: "/workspace", mode: "act" })

		expect(config.mediaBudget).toEqual({
			maxTotalMediaBytes: 20 * 1024 * 1024,
			maxImageEncodedBytes: 7 * 1024 * 1024,
			maxImageDecodedBytes: 9 * 1024 * 1024,
		})
		expect(config.extensions?.map((extension) => extension.name)).toContain("cline-image-descriptions")
	})

	it("uses today's image limits when none are stored", async () => {
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {}, providerId: "openai", modelId: "qwen" })
		const builder = new SdkSessionConfigBuilder({
			stateManager: { getGlobalSettingsKey: vi.fn(() => undefined) } as never,
			emitHookMessage: vi.fn(),
		})

		const config = await builder.build({ cwd: "/workspace", mode: "act" })

		expect(config.mediaBudget).toEqual({
			maxTotalMediaBytes: 8 * 1024 * 1024,
			maxImageEncodedBytes: 5 * 1024 * 1024,
			maxImageDecodedBytes: 6 * 1024 * 1024,
		})
	})

	// Cline Cubed: the Rules panel's switches reach the engine, read on every request.
	it("reports each rule and skill switched off in the Rules panel, and treats any other as on", async () => {
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {}, providerId: "openai", modelId: "qwen" })
		const globalSettings: Record<string, unknown> = {
			globalClineRulesToggles: { "/home/Documents/Cline/Rules/off.md": false, "/home/Documents/Cline/Rules/on.md": true },
			globalSkillsToggles: { "/home/.cline/skills/global-off": false },
		}
		const workspaceState: Record<string, unknown> = {
			localClineRulesToggles: { "/workspace/.clinerules/off.md": false },
			localAgentsRulesToggles: { "/workspace/AGENTS.md": false },
			localSkillsToggles: { "/workspace/.cline/skills/local-off": false },
		}
		const builder = new SdkSessionConfigBuilder({
			stateManager: {
				getGlobalSettingsKey: vi.fn((key: string) => globalSettings[key]),
				getWorkspaceStateKey: vi.fn((key: string) => workspaceState[key]),
			} as never,
			emitHookMessage: vi.fn(),
		})

		const config = await builder.build({ cwd: "/workspace", mode: "act" })
		const check = config.isInstructionEnabled
		expect(check).toBeDefined()
		if (!check) return

		expect(check("rule", "/home/Documents/Cline/Rules/off.md")).toBe(false)
		expect(check("rule", "/home/Documents/Cline/Rules/on.md")).toBe(true)
		expect(check("rule", "/workspace/.clinerules/off.md")).toBe(false)
		expect(check("rule", "/workspace/AGENTS.md")).toBe(false)
		expect(check("rule", "/workspace/.clinerules/never-switched.md")).toBe(true)
		expect(check("skill", "/home/.cline/skills/global-off/SKILL.md")).toBe(false)
		expect(check("skill", "/workspace/.cline/skills/local-off/SKILL.md")).toBe(false)
		expect(check("skill", "/workspace/.cline/skills/other/SKILL.md")).toBe(true)

		// A switch changed after the session started applies to the next request.
		workspaceState.localClineRulesToggles = { "/workspace/.clinerules/off.md": true }
		expect(check("rule", "/workspace/.clinerules/off.md")).toBe(true)
	})
})
