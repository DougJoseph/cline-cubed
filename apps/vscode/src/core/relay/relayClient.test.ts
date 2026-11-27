import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { RELAY_CANNOT_SAVE, type RelayEvent, RelayLink, validateRelayUrl } from "./relayClient"

const VERSION = "4.1.28"
const KEY = "0".repeat(64)

describe("validateRelayUrl", () => {
	it("accepts an https relay", () => {
		const { url, error } = validateRelayUrl("https://example.com/relay")
		expect(error).toBe("")
		expect(url?.host).toBe("example.com")
	})

	it("accepts plain http only on loopback, which is where a relay is tested before install", () => {
		expect(validateRelayUrl("http://127.0.0.1:8787/relay").error).toBe("")
		expect(validateRelayUrl("http://localhost:8787/relay").error).toBe("")
	})

	it("refuses a plain http relay on any other host, because the key would cross the wire in the clear", () => {
		expect(validateRelayUrl("http://example.com/relay").error).toBe("relay_requires_https")
	})

	it("refuses a scheme that is not http at all", () => {
		expect(validateRelayUrl("ftp://example.com/relay").error).toBe("unsupported_protocol")
	})

	it("names a value that is not a URL rather than throwing", () => {
		expect(validateRelayUrl("not a url").error).toBe("not_a_url")
	})
})

/**
 * A stand-in for the generated PHP bundle, so the handshake, the per-chat queues and the retry rules
 * can be tested. Routes arrive as `index.php?route=…`, as the real relay receives them.
 */
const startStubRelay = (overrides: { version?: string; failPoll?: boolean; exposeData?: boolean } = {}) => {
	const chats = new Map<string, { name: string; outbound: RelayEvent[]; inbound: RelayEvent[]; inboundCursor: number }>()
	const paths: string[] = []
	// A chat whose save the relay cannot make: its poll entry hands out nothing and carries the error.
	const cannotSave = new Set<string>()
	const readJson = async (request: AsyncIterable<unknown>) => {
		const chunks: Buffer[] = []
		for await (const chunk of request) {
			chunks.push(chunk as Buffer)
		}
		return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}
	}
	const json = (response: import("node:http").ServerResponse, status: number, body: unknown) => {
		response.writeHead(status, { "Content-Type": "application/json" })
		response.end(JSON.stringify(body))
	}
	const server: Server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1")
		paths.push(url.pathname)
		const route = url.searchParams.get("route") ?? ""
		const authorized = (request.headers.authorization ?? "") === `Bearer ${KEY}`

		if (url.pathname.endsWith("/data/config.json")) {
			if (overrides.exposeData) {
				json(response, 200, { version: VERSION })
				return
			}
			response.writeHead(403).end()
			return
		}
		if (route === "health") {
			json(response, 200, { ok: true, version: overrides.version ?? VERSION, installed: true })
			return
		}
		if (!authorized) {
			json(response, 401, { error: "invalid_relay_key" })
			return
		}
		if (request.method === "POST" && route === "session") {
			const body = (await readJson(request)) as { id: string; name: string }
			const existing = chats.get(body.id)
			chats.set(
				body.id,
				existing ? { ...existing, name: body.name } : { name: body.name, outbound: [], inbound: [], inboundCursor: 0 },
			)
			json(response, 200, { sessionId: body.id })
			return
		}
		if (request.method === "POST" && route === "poll") {
			if (overrides.failPoll) {
				json(response, 500, { error: "boom" })
				return
			}
			const body = (await readJson(request)) as { cursors: Record<string, number> }
			const sessions: Record<string, { events: RelayEvent[]; cursor: number; dropped: number; error?: string }> = {}
			const missing: string[] = []
			for (const [id, after] of Object.entries(body.cursors)) {
				const chat = chats.get(id)
				if (!chat) {
					missing.push(id)
					continue
				}
				if (cannotSave.has(id)) {
					sessions[id] = { events: [], cursor: after, dropped: 0, error: "relay_save_failed" }
					continue
				}
				const events = chat.inbound.filter((event) => (event.seq ?? 0) > after)
				chat.inbound = []
				sessions[id] = { events, cursor: chat.inboundCursor, dropped: 0 }
			}
			json(response, 200, { sessions, missing })
			return
		}
		const match = route.match(/^session\/([^/]+)\/outbound$/)
		const chat = match ? chats.get(match[1]) : undefined
		if (match && chat && request.method === "POST") {
			const body = (await readJson(request)) as { events?: RelayEvent[] }
			chat.outbound.push(...(body.events ?? []))
			json(response, 200, { accepted: (body.events ?? []).length, dropped: 0 })
			return
		}
		json(response, 404, { error: "unknown_route" })
	})

	return new Promise<{
		url: string
		chats: typeof chats
		paths: string[]
		cannotSave: Set<string>
		deviceSends: (chatId: string, event: RelayEvent) => void
		close: () => Promise<void>
	}>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo
			resolve({
				url: `http://127.0.0.1:${port}/relay`,
				chats,
				paths,
				cannotSave,
				deviceSends: (chatId, event) => {
					const target = chats.get(chatId)
					if (target) {
						target.inboundCursor += 1
						target.inbound.push({ ...event, seq: target.inboundCursor })
					}
				},
				close: () =>
					new Promise<void>((done) => {
						server.close(() => done())
					}),
			})
		})
	})
}

const waitFor = async (condition: () => boolean, ms = 3000) => {
	const deadline = Date.now() + ms
	while (!condition() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 30))
	}
}

describe("RelayLink", () => {
	let relay: Awaited<ReturnType<typeof startStubRelay>> | null = null

	afterEach(async () => {
		await relay?.close()
		relay = null
	})

	it("refuses to build a link to a relay it would send its key to in the clear", () => {
		expect(() => new RelayLink({ url: "http://example.com/relay", key: KEY, extensionVersion: VERSION })).toThrow(
			/Relay URL rejected \(relay_requires_https\)/,
		)
	})

	it("connects, registers each shared chat under its own id, and reports the relay's own host", async () => {
		relay = await startStubRelay()
		const link = new RelayLink({ url: relay.url, key: KEY, extensionVersion: VERSION, pollIntervalMs: 50 })
		await link.setSharedChats([{ id: "chat-0001", name: "My chat" }])
		const status = await link.start()
		expect(status.state).toBe("connected")
		expect(status.error).toBe("")
		expect(relay.chats.get("chat-0001")?.name).toBe("My chat")
		link.stop()
	})

	it("refuses a relay that is not the version that exported it, naming both versions", async () => {
		relay = await startStubRelay({ version: "4.1.20" })
		const link = new RelayLink({ url: relay.url, key: KEY, extensionVersion: VERSION, pollIntervalMs: 50 })
		const status = await link.start()
		expect(status.state).toBe("failed")
		expect(status.error).toContain("relay_version_mismatch")
		expect(status.error).toContain("relay is 4.1.20")
		expect(status.error).toContain(`this extension is ${VERSION}`)
		link.stop()
	})

	it("carries a shared chat's events up to that chat's queue on the relay", async () => {
		relay = await startStubRelay()
		const link = new RelayLink({ url: relay.url, key: KEY, extensionVersion: VERSION, pollIntervalMs: 50 })
		await link.setSharedChats([{ id: "chat-0001", name: "My chat" }])
		await link.start()
		const event = { kind: "messages", payload: { messages: [] }, sentAt: Date.now() }
		expect(await link.post("chat-0001", [event])).toBe(true)
		expect(relay.chats.get("chat-0001")?.outbound.map((sent) => sent.kind)).toEqual(["messages"])
		expect(await link.post("not-shared", [event])).toBe(false)
		link.stop()
	})

	it("delivers what a paired device sent to the chat it was sent to", async () => {
		relay = await startStubRelay()
		const received: Array<{ chatId: string; event: RelayEvent }> = []
		const link = new RelayLink({
			url: relay.url,
			key: KEY,
			extensionVersion: VERSION,
			pollIntervalMs: 40,
			onChatEvent: (chatId, event) => received.push({ chatId, event }),
		})
		await link.setSharedChats([
			{ id: "chat-0001", name: "First" },
			{ id: "chat-0002", name: "Second" },
		])
		await link.start()
		relay.deviceSends("chat-0002", { kind: "message", payload: { text: "from the phone" }, sentAt: Date.now() })
		await waitFor(() => received.length > 0)
		expect(received).toHaveLength(1)
		expect(received[0].chatId).toBe("chat-0002")
		expect((received[0].event.payload as { text: string }).text).toBe("from the phone")
		link.stop()
	})

	it("reports a chat the relay could not save, keeps the other chats flowing, and delivers it once the save works", async () => {
		relay = await startStubRelay()
		const received: Array<{ chatId: string; text: string }> = []
		const link = new RelayLink({
			url: relay.url,
			key: KEY,
			extensionVersion: VERSION,
			pollIntervalMs: 40,
			onChatEvent: (chatId, event) => received.push({ chatId, text: (event.payload as { text: string }).text }),
		})
		await link.setSharedChats([
			{ id: "chat-0001", name: "First" },
			{ id: "chat-0002", name: "Second" },
		])
		await link.start()
		relay.cannotSave.add("chat-0002")
		relay.deviceSends("chat-0001", { kind: "message", payload: { text: "to the first" }, sentAt: Date.now() })
		relay.deviceSends("chat-0002", { kind: "message", payload: { text: "to the second" }, sentAt: Date.now() })
		await waitFor(() => received.length > 0 && link.currentStatus().error === RELAY_CANNOT_SAVE)
		expect(link.currentStatus().state).toBe("connected")
		expect(link.currentStatus().error).toBe(RELAY_CANNOT_SAVE)
		expect(received).toEqual([{ chatId: "chat-0001", text: "to the first" }])

		relay.cannotSave.delete("chat-0002")
		await waitFor(() => received.length > 1 && link.currentStatus().error === "")
		await new Promise((resolve) => setTimeout(resolve, 150))
		expect(link.currentStatus().error).toBe("")
		expect(received).toEqual([
			{ chatId: "chat-0001", text: "to the first" },
			{ chatId: "chat-0002", text: "to the second" },
		])
		link.stop()
	})

	it("backs off on a failing relay instead of hammering it at the poll interval", async () => {
		relay = await startStubRelay({ failPoll: true })
		const link = new RelayLink({ url: relay.url, key: KEY, extensionVersion: VERSION, pollIntervalMs: 30 })
		await link.setSharedChats([{ id: "chat-0001", name: "My chat" }])
		await link.start()
		await waitFor(() => link.currentStatus().consecutiveFailures >= 2, 2000)
		const status = link.currentStatus()
		expect(status.state).toBe("failed")
		expect(status.consecutiveFailures).toBeGreaterThanOrEqual(2)
		expect(status.nextPollInMs).toBeGreaterThan(30)
		expect(status.error).toContain("relay_poll_500")
		link.stop()
	})

	it("names the host and records the last attempt once the relay cannot be reached", async () => {
		const link = new RelayLink({ url: "http://127.0.0.1:1/relay", key: KEY, extensionVersion: VERSION, pollIntervalMs: 20 })
		const status = await link.start()
		expect(status.state).toBe("failed")
		expect(status.host).toBe("127.0.0.1:1")
		expect(status.lastAttemptAt).toBeGreaterThan(0)
		link.stop()
		expect(link.currentStatus().state).toBe("idle")
	})

	it("reaches a relay installed in a subfolder through that folder's own index.php", async () => {
		relay = await startStubRelay()
		const link = new RelayLink({
			url: `${relay.url}/installed-here`,
			key: KEY,
			extensionVersion: VERSION,
			pollIntervalMs: 50,
		})
		const status = await link.start()
		expect(status.state).toBe("connected")
		expect(relay.paths).toContain("/relay/installed-here/index.php")
		link.stop()
	})

	it("refuses to connect to a relay whose data directory is readable over the web", async () => {
		relay = await startStubRelay({ exposeData: true })
		const link = new RelayLink({ url: relay.url, key: KEY, extensionVersion: VERSION, pollIntervalMs: 50 })
		await link.setSharedChats([{ id: "chat-0001", name: "My chat" }])
		const status = await link.start()
		expect(status.state).toBe("failed")
		expect(status.error).toContain("relay_exposed")
		// Registration never happens: an exposed relay is not connected, half-working or otherwise.
		expect(relay.chats.size).toBe(0)
		link.stop()
	})

	it("connects when the data probe comes back 403", async () => {
		relay = await startStubRelay()
		const link = new RelayLink({ url: relay.url, key: KEY, extensionVersion: VERSION, pollIntervalMs: 50 })
		const status = await link.start()
		expect(status.state).toBe("connected")
		link.stop()
	})
})
