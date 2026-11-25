import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Cline Cubed: the remote-endpoint warning follows the chat's current address, deciding on each
 * message and remembering the answer per address.
 */

const entries = vi.hoisted(() => ({ value: [] as string[] }))
vi.mock("@cline/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cline/core")>()
	return { ...actual, readAlwaysRememberedFilesGlobally: () => entries.value }
})

import { createAlwaysRememberedFilesExtension, createEndpointLocalCheck } from "./always-remembered-files"

let dir: string

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "endpoint-check-"))
})

afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

describe("createEndpointLocalCheck", () => {
	it("looks an address up once across several messages", async () => {
		const lookup = vi.fn(async () => [{ address: "100.101.102.103", family: 4 }])
		const check = createEndpointLocalCheck(
			() => ({ providerId: "openai", baseUrl: "http://box.example.ts.net:8080/v1" }),
			lookup,
		)

		expect(await check()).toBe(true)
		expect(await check()).toBe(true)
		expect(await check()).toBe(true)
		expect(lookup).toHaveBeenCalledTimes(1)
	})

	it("decides again when the address changes", async () => {
		let baseUrl = "http://box.example.ts.net:8080/v1"
		const lookup = vi.fn(async (host: string) =>
			host.startsWith("box") ? [{ address: "100.101.102.103", family: 4 }] : [{ address: "203.0.113.9", family: 4 }],
		)
		const check = createEndpointLocalCheck(() => ({ providerId: "openai", baseUrl }), lookup)

		expect(await check()).toBe(true)
		baseUrl = "https://api.example.com/v1"
		expect(await check()).toBe(false)
		baseUrl = "http://box.example.ts.net:8080/v1"
		expect(await check()).toBe(true)
		expect(lookup).toHaveBeenCalledTimes(2)
	})

	it("retries a failed lookup on the next message instead of remembering it", async () => {
		const lookup = vi
			.fn<(host: string) => Promise<Array<{ address: string; family: number }>>>()
			.mockRejectedValueOnce(new Error("ENOTFOUND"))
			.mockResolvedValue([{ address: "100.101.102.103", family: 4 }])
		const check = createEndpointLocalCheck(() => ({ providerId: "openai", baseUrl: "http://box.example.ts.net/v1" }), lookup)

		expect(await check()).toBe(false)
		expect(await check()).toBe(true)
		expect(lookup).toHaveBeenCalledTimes(2)
	})
})

describe("the remote-endpoint warning in an open chat", () => {
	it("appears after the chat moves to a remote address, and clears after a move back", async () => {
		const file = join(dir, "contract.md")
		writeFileSync(file, "# Contract\nRule.\n")
		entries.value = [file]
		let local = true
		const emitWarning = vi.fn()
		const extension = createAlwaysRememberedFilesExtension({
			cwd: dir,
			isEndpointLocal: async () => local,
			emitWarning,
		})
		let content: () => Promise<string> = async () => ""
		await extension.setup?.(
			{ registerRule: (rule: { content: () => Promise<string> }) => (content = rule.content) } as never,
			{ session: { sessionId: "chat-1" } } as never,
		)
		const remoteWarnings = () =>
			emitWarning.mock.calls.filter(([text]) => String(text).includes("remote model endpoint")).length

		await content()
		expect(remoteWarnings()).toBe(0)

		local = false
		await content()
		expect(remoteWarnings()).toBe(1)

		local = true
		await content()
		await content()
		local = false
		await content()
		expect(remoteWarnings()).toBe(2)
	})
})
