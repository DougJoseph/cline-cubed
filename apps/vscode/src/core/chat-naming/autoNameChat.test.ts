import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildApiHandler } from "@/sdk/sdk-api-handler"
import { Logger } from "@/shared/services/Logger"
import {
	autoNameChat,
	autoNameChatInBackground,
	CHAT_NAME_INSTRUCTION,
	extractChatName,
	MAX_CHAT_NAME_LENGTH,
} from "./autoNameChat"

vi.mock("@/sdk/sdk-api-handler", () => ({
	buildApiHandler: vi.fn(),
}))

vi.mock("@/shared/services/Logger", () => ({
	Logger: {
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		log: vi.fn(),
	},
}))

type Chunk = { type: "text"; text: string } | { type: "done"; success: boolean; error?: string }

function stubHandler(chunks: Chunk[]) {
	const createMessage = vi.fn(async function* () {
		for (const chunk of chunks) {
			yield chunk
		}
	})
	vi.mocked(buildApiHandler).mockReturnValue({ createMessage } as never)
	return createMessage
}

function makeInput(overrides: Partial<Parameters<typeof autoNameChat>[0]> = {}) {
	return {
		sessionId: "session-1",
		prompt: "How do I best kill a pumpkin with a rifle?",
		mode: "act" as const,
		apiConfiguration: {} as never,
		applyName: vi.fn().mockResolvedValue(undefined),
		...overrides,
	}
}

describe("extractChatName", () => {
	it("trims and strips surrounding quotes", () => {
		expect(extractChatName('  "Kill a pumpkin"  ')).toBe("Kill a pumpkin")
		expect(extractChatName("“Kill a pumpkin”")).toBe("Kill a pumpkin")
		expect(extractChatName("`Kill a pumpkin`")).toBe("Kill a pumpkin")
	})

	it("truncates an over-long name at a word boundary, within the limit, with an ellipsis", () => {
		const long = "Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november"
		const name = extractChatName(long)
		expect(name).toBeDefined()
		expect(name!.length).toBeLessThanOrEqual(MAX_CHAT_NAME_LENGTH)
		expect(name!.endsWith("…")).toBe(true)
		expect(name!.slice(0, -1)).not.toMatch(/\s$/)
		expect(long.startsWith(name!.slice(0, -1))).toBe(true)
	})

	it("discards only a non-name: empty, a line break, or far past the limit", () => {
		expect(extractChatName("")).toBeUndefined()
		expect(extractChatName("   ")).toBeUndefined()
		expect(extractChatName("Kill a pumpkin\nwith a rifle")).toBeUndefined()
		expect(extractChatName("x".repeat(MAX_CHAT_NAME_LENGTH * 4 + 1))).toBeUndefined()
	})
})

describe("CHAT_NAME_INSTRUCTION", () => {
	it("names both limits, the character one from the enforced constant", () => {
		expect(CHAT_NAME_INSTRUCTION).toContain("six words")
		expect(CHAT_NAME_INSTRUCTION).toContain(`${MAX_CHAT_NAME_LENGTH} characters`)
	})
})

describe("autoNameChat", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("asks the person's own provider in the chat's channel and stores the answer as the name", async () => {
		const createMessage = stubHandler([
			{ type: "text", text: "Kill a " },
			{ type: "text", text: "pumpkin" },
		])
		const input = makeInput({ mode: "plan" })

		await expect(autoNameChat(input)).resolves.toBe("Kill a pumpkin")

		expect(buildApiHandler).toHaveBeenCalledWith(input.apiConfiguration, "plan", { disableReasoning: true })
		expect(createMessage).toHaveBeenCalledWith(CHAT_NAME_INSTRUCTION, [{ role: "user", content: input.prompt }])
		expect(input.applyName).toHaveBeenCalledWith("session-1", "Kill a pumpkin")
	})

	it("sends only the opening of a very long first prompt", async () => {
		const createMessage = stubHandler([{ type: "text", text: "Long log" }])
		const input = makeInput({ prompt: "x".repeat(5000) })

		await autoNameChat(input)

		const [, messages] = createMessage.mock.calls[0] as unknown as [string, { content: string }[]]
		expect(messages[0].content.length).toBe(2000)
	})

	it("stores nothing and reports a provider error, unconditionally", async () => {
		stubHandler([{ type: "done", success: false, error: "401 unauthorized" }])
		const input = makeInput()

		await expect(autoNameChat(input)).resolves.toBeUndefined()

		expect(input.applyName).not.toHaveBeenCalled()
		expect(Logger.error).toHaveBeenCalledWith(expect.stringContaining("401 unauthorized"))
	})

	it("stores nothing and reports an unusable answer, unconditionally", async () => {
		stubHandler([{ type: "text", text: "Sure! Here is a name:\nKill a pumpkin" }])
		const input = makeInput()

		await expect(autoNameChat(input)).resolves.toBeUndefined()

		expect(input.applyName).not.toHaveBeenCalled()
		expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining("no usable name"))
	})

	it("does nothing for an empty prompt", async () => {
		const input = makeInput({ prompt: "   " })

		await expect(autoNameChat(input)).resolves.toBeUndefined()

		expect(buildApiHandler).not.toHaveBeenCalled()
	})
})

describe("autoNameChatInBackground", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("reports a thrown failure — from the request or from storing — unconditionally", async () => {
		stubHandler([{ type: "text", text: "Kill a pumpkin" }])
		const input = makeInput({ applyName: vi.fn().mockRejectedValue(new Error("row vanished")) })

		autoNameChatInBackground(input)
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(Logger.error).toHaveBeenCalledWith(expect.stringContaining("row vanished"))
	})

	it("returns immediately — nothing waits on the request", () => {
		let release: () => void = () => {}
		const createMessage = vi.fn(async function* () {
			await new Promise<void>((resolve) => {
				release = resolve
			})
			yield { type: "text", text: "Kill a pumpkin" }
		})
		vi.mocked(buildApiHandler).mockReturnValue({ createMessage } as never)

		const before = Date.now()
		autoNameChatInBackground(makeInput())
		expect(Date.now() - before).toBeLessThan(50)
		release()
	})
})
