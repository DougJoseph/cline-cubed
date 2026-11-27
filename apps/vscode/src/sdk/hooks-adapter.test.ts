import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildAgentHooks } from "./hooks-adapter"

const hookFactory = vi.hoisted(() => ({ run: vi.fn(), create: vi.fn() }))
vi.mock("@/core/hooks/hook-factory", () => ({
	HookFactory: class {
		create = hookFactory.create
	},
}))

beforeEach(() => {
	hookFactory.run.mockReset().mockResolvedValue({})
	hookFactory.create.mockReset().mockResolvedValue({ isNoOp: false, run: hookFactory.run })
})

describe("the Task Complete hook", () => {
	it("receives the reply without its consent_suggestion line", async () => {
		const stateManager = { getGlobalSettingsKey: () => true }
		const hooks = buildAgentHooks(stateManager as never)

		await hooks.afterRun?.({
			snapshot: { messages: [] },
			result: {
				status: "completed",
				outputText: "Should I commit?\n<consent_suggestion>yes, commit them</consent_suggestion>",
			},
		} as never)

		expect(hookFactory.create).toHaveBeenCalledWith("TaskComplete")
		const [input] = hookFactory.run.mock.calls[0] as [{ taskComplete: { taskMetadata: { result: string } } }]
		expect(input.taskComplete.taskMetadata.result).toBe("Should I commit?")
	})
})

describe("the User Prompt Submit hook", () => {
	it("receives the user's message without the consent reminder", async () => {
		const reminder =
			"<consent_reminder>If your reply asks for my go, end it with one line: <consent_suggestion>yes, …</consent_suggestion></consent_reminder>"
		const stateManager = { getGlobalSettingsKey: () => true }
		const hooks = buildAgentHooks(stateManager as never)

		await hooks.beforeRun?.({
			snapshot: {
				runId: "r",
				iteration: 0,
				messages: [{ role: "user", content: [{ type: "text", text: `please plan it\n${reminder}` }] }],
			},
		} as never)

		const submit = hookFactory.run.mock.calls.find(([input]) => "userPromptSubmit" in (input as object))
		expect(submit).toBeDefined()
		expect((submit?.[0] as { userPromptSubmit: { prompt: string } }).userPromptSubmit.prompt).toBe("please plan it")
	})
})

describe("the User Prompt Submit hook and the image description reminder", () => {
	it("receives the user's message without the image description reminder", async () => {
		const reminder =
			'<image_description_reminder>For each picture after an "Image N:" line, end your reply with: <image_description id="N">…</image_description></image_description_reminder>'
		const stateManager = { getGlobalSettingsKey: () => true }
		const hooks = buildAgentHooks(stateManager as never)

		await hooks.beforeRun?.({
			snapshot: {
				runId: "r",
				iteration: 0,
				messages: [{ role: "user", content: [{ type: "text", text: `look at this\n${reminder}` }] }],
			},
		} as never)

		const submit = [...hookFactory.run.mock.calls].reverse().find(([input]) => "userPromptSubmit" in (input as object))
		expect((submit?.[0] as { userPromptSubmit: { prompt: string } }).userPromptSubmit.prompt).toBe("look at this")
	})
})
