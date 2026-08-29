import { beforeEach, describe, expect, it, vi } from "vitest"
import { askResponse } from "./askResponse"

// Passthrough: the image bridge is not under test here.
vi.mock("../../bridge/interceptImages", () => ({
	interceptImagesForNonVisionModel: vi.fn(async ({ text, images }: { text: string; images: string[] }) => ({
		text,
		images,
	})),
}))

vi.mock("@/shared/services/Logger", () => ({
	Logger: { debug: vi.fn(), error: vi.fn(), log: vi.fn(), warn: vi.fn() },
}))

function makeTask() {
	return { handleWebviewAskResponse: vi.fn().mockResolvedValue(undefined) }
}

function makeController(overrides: Record<string, unknown> = {}) {
	return {
		task: undefined,
		getTaskForSession: vi.fn(() => undefined),
		reinitExistingTaskFromId: vi.fn().mockResolvedValue(undefined),
		getProviderConfigStore: vi.fn(() => ({})),
		stateManager: {
			getApiConfiguration: vi.fn(() => ({})),
			getGlobalSettingsKey: vi.fn(() => undefined),
		},
		...overrides,
	}
}

describe("askResponse handler — session addressing", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("delivers a named response to THAT session's task", async () => {
		const targetTask = makeTask()
		const focusedTask = makeTask()
		const controller = makeController({
			task: focusedTask,
			getTaskForSession: vi.fn((sessionId: string) => (sessionId === "chat-a" ? targetTask : undefined)),
		})

		await askResponse(controller as never, { responseType: "messageResponse", text: "hi", sessionId: "chat-a" } as never)

		expect(targetTask.handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "hi", [], undefined)
		expect(focusedTask.handleWebviewAskResponse).not.toHaveBeenCalled()
	})

	it("revives a named session that is not resident, then delivers to it", async () => {
		const revivedTask = makeTask()
		let revived = false
		const controller = makeController({
			task: makeTask(),
			getTaskForSession: vi.fn((sessionId: string) => (sessionId === "chat-a" && revived ? revivedTask : undefined)),
			reinitExistingTaskFromId: vi.fn(async () => {
				revived = true
			}),
		})

		await askResponse(controller as never, { responseType: "messageResponse", text: "hi", sessionId: "chat-a" } as never)

		expect(controller.reinitExistingTaskFromId).toHaveBeenCalledWith("chat-a")
		expect(revivedTask.handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "hi", [], undefined)
	})

	it("REFUSES a named response whose session cannot be revived — never delivers it to the focused chat", async () => {
		// A message stamped for one chat must never be delivered to whichever chat is focused.
		const focusedTask = makeTask()
		const controller = makeController({ task: focusedTask })

		await askResponse(controller as never, { responseType: "messageResponse", text: "hi", sessionId: "gone" } as never)

		expect(controller.reinitExistingTaskFromId).toHaveBeenCalledWith("gone")
		expect(focusedTask.handleWebviewAskResponse).not.toHaveBeenCalled()
	})

	it("keeps the surface-less legacy contract: no named session falls to the focused task", async () => {
		const focusedTask = makeTask()
		const controller = makeController({ task: focusedTask })

		await askResponse(controller as never, { responseType: "messageResponse", text: "hi", sessionId: "" } as never)

		expect(focusedTask.handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "hi", [], undefined)
		expect(controller.reinitExistingTaskFromId).not.toHaveBeenCalled()
	})
})
