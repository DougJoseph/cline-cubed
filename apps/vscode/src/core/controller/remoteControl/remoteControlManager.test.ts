import { strict as assert } from "node:assert"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, it, vi } from "vitest"
import { ExtensionRegistryInfo } from "@/registry"

const { store, hub, relay } = vi.hoisted(() => ({
	store: { enabled: false, shared: [] as string[] },
	hub: { mode: "ok" as "ok" | "throw" | "empty", starts: 0, closes: 0 },
	relay: { url: "", key: "", pollIntervalMs: 1500 },
}))

vi.mock("@cline/core", () => ({
	readRemoteControlEnabledGlobally: () => store.enabled,
	setRemoteControlEnabledGlobally: (value: boolean) => {
		store.enabled = value
	},
	readRelaySettingsGlobally: () => ({ ...relay }),
	readRemoteSharedChatsGlobally: () => [...store.shared],
	setRemoteChatSharedGlobally: (chatId: string, shared: boolean) => {
		store.shared = store.shared.filter((id) => id !== chatId)
		if (shared) {
			store.shared.push(chatId)
		}
		return [...store.shared]
	},
	resolveCompactionTriggerTokens: ({ contextWindow }: { contextWindow?: number }) =>
		contextWindow ? contextWindow * 0.81 : undefined,
	createLocalHubScheduleRuntimeHandlers: () => ({}),
	ensureHubServer: async () => {
		hub.starts++
		if (hub.mode === "throw") {
			throw new Error("EADDRINUSE: address already in use 127.0.0.1:25443")
		}
		if (hub.mode === "empty") {
			return { url: "ws://127.0.0.1:25443/hub", action: "started" as const }
		}
		return {
			url: "ws://127.0.0.1:25443/hub",
			action: "started" as const,
			server: {
				host: "127.0.0.1",
				port: 25443,
				url: "ws://127.0.0.1:25443/hub",
				authToken: "test-token",
				beginClose: () => ({ transportStopped: Promise.resolve(), closed: Promise.resolve() }),
				close: async () => {
					hub.closes++
				},
			},
		}
	},
}))

vi.mock("@/shared/services/Logger", () => ({
	Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { RemoteControlManager } from "./remoteControlManager"

const freshManager = () => {
	store.enabled = false
	store.shared = []
	hub.mode = "ok"
	hub.starts = 0
	hub.closes = 0
	relay.url = ""
	relay.key = ""
	relay.pollIntervalMs = 1500
	return new RemoteControlManager()
}

describe("RemoteControlManager", () => {
	it("stays disconnected when the stored choice is off, and starts no hub", async () => {
		const manager = freshManager()
		const status = await manager.ensureRestored()

		assert.equal(status.state, "disconnected")
		assert.equal(status.enabled, false)
		assert.equal(status.url, "")
		assert.equal(hub.starts, 0)
	})

	it("brings the hub up when the stored choice was left on", async () => {
		const manager = freshManager()
		store.enabled = true

		const status = await manager.ensureRestored()

		assert.equal(status.state, "connected")
		assert.equal(status.enabled, true)
		assert.equal(status.url, "ws://127.0.0.1:25443/hub")
		assert.equal(hub.starts, 1)
	})

	it("reads the stored choice once per process", async () => {
		const manager = freshManager()
		await manager.ensureRestored()
		store.enabled = true
		const second = await manager.ensureRestored()

		assert.equal(second.state, "disconnected")
		assert.equal(hub.starts, 0)
	})

	it("toggle turns the mode on, persists it, and reports the confirmed state", async () => {
		const manager = freshManager()
		await manager.ensureRestored()

		const status = await manager.toggle()

		assert.equal(status.state, "connected")
		assert.equal(status.enabled, true)
		assert.equal(store.enabled, true)
	})

	it("toggle again turns the mode off and closes the hub it opened", async () => {
		const manager = freshManager()
		await manager.toggle()

		const status = await manager.toggle()

		assert.equal(status.state, "disconnected")
		assert.equal(status.enabled, false)
		assert.equal(status.url, "")
		assert.equal(store.enabled, false)
		assert.equal(hub.closes, 1)
	})

	it("reports a named failure when the hub cannot start, and keeps the stored choice", async () => {
		const manager = freshManager()
		hub.mode = "throw"

		const status = await manager.toggle()

		assert.equal(status.state, "failed")
		assert.equal(status.enabled, true)
		assert.equal(status.error, "EADDRINUSE: address already in use 127.0.0.1:25443")
		assert.equal(status.url, "")
		assert.equal(store.enabled, true)
	})

	it("reports a failure when the hub answers without a running server", async () => {
		const manager = freshManager()
		hub.mode = "empty"

		const status = await manager.toggle()

		assert.equal(status.state, "failed")
		assert.equal(status.error, "The hub reported no running server.")
	})

	it("joins one in-flight toggle rather than racing a start against a stop", async () => {
		const manager = freshManager()

		const [first, second] = await Promise.all([manager.toggle(), manager.toggle()])

		assert.equal(hub.starts, 1)
		assert.equal(first.state, "connected")
		assert.deepEqual(second, first)
	})

	it("dispose stops the transport without erasing the choice the next activation reads", async () => {
		const manager = freshManager()
		await manager.toggle()

		await manager.dispose()

		assert.equal(hub.closes, 1)
		assert.equal(store.enabled, true)
		assert.equal(manager.status().state, "disconnected")
	})
})

/** A relay that answers the handshake and registers a session, so the manager's link can be proven. */
function startRelayStub(): Promise<{ url: string; host: string; close: () => Promise<void> }> {
	const server = createServer((request, response) => {
		// Routes arrive as index.php?route=…, as the real relay receives them.
		const url = new URL(request.url ?? "/", "http://127.0.0.1")
		const route = url.searchParams.get("route") ?? ""
		const json = (status: number, payload: unknown) => {
			response.writeHead(status, { "Content-Type": "application/json" })
			response.end(JSON.stringify(payload))
		}
		if (url.pathname.endsWith("/data/config.json")) {
			response.writeHead(404).end()
			return
		}
		if (route === "health") {
			json(200, { ok: true, version: ExtensionRegistryInfo.version, installed: true })
			return
		}
		if ((request.headers.authorization ?? "") !== "Bearer test-key") {
			json(401, { error: "invalid_relay_key" })
			return
		}
		if (route === "session") {
			json(200, { sessionId: "stub-session" })
			return
		}
		if (route === "status") {
			json(200, { version: ExtensionRegistryInfo.version, sessions: [], dataDir: "/home/relay/.cline-cubed-relay/abc" })
			return
		}
		json(404, { error: "unknown_route" })
	})
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo
			resolve({
				url: `http://127.0.0.1:${port}/relay`,
				host: `127.0.0.1:${port}`,
				close: () => new Promise<void>((done) => server.close(() => done())),
			})
		})
	})
}

describe("RemoteControlManager relay link", () => {
	it("reports no relay state at all when none is configured", async () => {
		const manager = freshManager()
		const status = await manager.toggle()

		assert.equal(status.state, "connected")
		assert.equal(status.relayState, "")
		assert.equal(status.relayHost, "")
		assert.equal(status.relayError, "")
		await manager.dispose()
	})

	it("names the refusal when the stored relay URL would send the key in the clear", async () => {
		const manager = freshManager()
		relay.url = "http://relay.example.com/relay"
		relay.key = "test-key"

		const status = await manager.toggle()

		assert.equal(status.relayState, "failed")
		assert.equal(status.relayError, "relay_requires_https")
		await manager.dispose()
	})

	it("opens the outbound link to a reachable relay and reports it", async () => {
		const stub = await startRelayStub()
		const manager = freshManager()
		relay.url = stub.url
		relay.key = "test-key"

		try {
			const status = await manager.toggle()
			assert.equal(status.relayState, "connected", JSON.stringify(status))
			assert.equal(status.relayHost, stub.host)
			assert.equal(status.relayError, "")
			await manager.dispose()
			assert.equal(manager.status().relayState, "")
		} finally {
			await stub.close()
		}
	})

	it("re-opens the link from the new values when the settings change", async () => {
		const first = await startRelayStub()
		const second = await startRelayStub()
		const manager = freshManager()
		relay.url = first.url
		relay.key = "test-key"

		try {
			const started = await manager.toggle()
			assert.equal(started.relayHost, first.host)

			relay.url = second.url
			const updated = await manager.applyRelaySettings()
			assert.equal(updated.relayHost, second.host, JSON.stringify(updated))
			assert.equal(updated.relayState, "connected")
			await manager.dispose()
		} finally {
			await first.close()
			await second.close()
		}
	})
})

/**
 * A relay that holds per-chat queues, hands the extension what a device sent through one combined
 * poll, and records what the extension posts — failing the next N posts on request.
 */
function startChatRelayStub() {
	const inbound = new Map<string, Array<{ kind: string; payload: unknown; sentAt: number; seq: number }>>()
	const outbound: Array<{ chatId: string; kind: string; payload: any }> = []
	const control = { failPosts: 0, failedPosts: 0 }
	let seq = 0
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1")
		const route = url.searchParams.get("route") ?? ""
		const chunks: Buffer[] = []
		for await (const chunk of request) {
			chunks.push(chunk as Buffer)
		}
		const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}
		const json = (status: number, payload: unknown) => {
			response.writeHead(status, { "Content-Type": "application/json" })
			response.end(JSON.stringify(payload))
		}
		if (url.pathname.endsWith("/data/config.json")) {
			response.writeHead(404).end()
			return
		}
		if (route === "health") {
			json(200, { ok: true, version: ExtensionRegistryInfo.version, installed: true })
			return
		}
		if (route === "status") {
			json(200, { version: ExtensionRegistryInfo.version, sessions: [], dataDir: "" })
			return
		}
		if (route === "session") {
			inbound.set(body.id, inbound.get(body.id) ?? [])
			json(200, { sessionId: body.id })
			return
		}
		if (route === "poll") {
			const sessions: Record<string, unknown> = {}
			for (const id of Object.keys(body.cursors ?? {})) {
				const events = inbound.get(id) ?? []
				inbound.set(id, [])
				sessions[id] = { events, cursor: seq, dropped: 0 }
			}
			json(200, { sessions, missing: [] })
			return
		}
		const match = route.match(/^session\/([^/]+)\/outbound$/)
		if (match) {
			if (control.failPosts > 0) {
				control.failPosts--
				control.failedPosts++
				json(500, { error: "boom" })
				return
			}
			for (const event of body.events ?? []) {
				outbound.push({ chatId: match[1], kind: event.kind, payload: event.payload })
			}
			json(200, { accepted: (body.events ?? []).length, dropped: 0 })
			return
		}
		json(404, { error: "unknown_route" })
	})
	return new Promise<{
		url: string
		outbound: typeof outbound
		control: typeof control
		deviceSends: (chatId: string, kind: string, payload: unknown) => void
		close: () => Promise<void>
	}>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo
			resolve({
				url: `http://127.0.0.1:${port}/relay`,
				outbound,
				control,
				deviceSends: (chatId, kind, payload) => {
					seq++
					inbound.get(chatId)?.push({ kind, payload, sentAt: Date.now(), seq })
				},
				close: () => new Promise<void>((done) => server.close(() => done())),
			})
		})
	})
}

const waitUntil = async (condition: () => boolean, ms = 6000) => {
	const deadline = Date.now() + ms
	while (!condition() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25))
	}
	return condition()
}

/** A chat the manager can read and drive, recording what it was asked to do. */
function fakeChat(messages: Array<{ ts: number; type: string; ask?: string; say?: string; text?: string; partial?: boolean }>) {
	const calls = { decide: [] as Array<{ ts: number; approve: boolean }>, send: [] as string[] }
	const access = {
		view: async () => ({
			messages: messages as any,
			working: false,
			title: "A chat",
			workspace: "project",
			contextUsed: 0,
			usage: { tokensIn: 0, tokensOut: 0, cacheWrites: 0, cacheReads: 0, cost: 0 },
			running: false,
			isActive: true,
		}),
		send: async (_chatId: string, text: string) => {
			calls.send.push(text)
		},
		decide: async (_chatId: string, ts: number, approve: boolean) => {
			calls.decide.push({ ts, approve })
		},
		rename: async () => {},
		getAutoApprove: async (): Promise<Record<string, boolean>> => ({ readFiles: true }),
		setAutoApprove: async (_action: string, _enabled: boolean) => {},
		contextLimits: async () => ({ window: 1000, compactAt: 810 }),
		allChatsCost: async () => 0,
		compact: async () => "",
	}
	return { access, calls }
}

describe("RemoteControlManager shared chats", () => {
	it("posts a chat's changes again after a failed post, so nothing is lost", async () => {
		const stub = await startChatRelayStub()
		const manager = freshManager()
		relay.url = stub.url
		relay.key = "test-key"
		relay.pollIntervalMs = 40
		store.shared = ["chat-0001"]
		const messages = [{ ts: 1, type: "say", say: "text", text: "first" }]
		const { access } = fakeChat(messages)
		manager.setChatAccess(access)
		try {
			await manager.toggle()
			stub.deviceSends("chat-0001", "sync", {})
			assert.ok(await waitUntil(() => stub.outbound.some((event) => event.kind === "snapshot")), "no snapshot was posted")

			// The next post fails; the change must still arrive on the one after.
			stub.control.failPosts = 1
			messages.push({ ts: 2, type: "say", say: "text", text: "second" })
			const arrived = await waitUntil(() =>
				stub.outbound.some(
					(event) => event.kind === "update" && (event.payload.messages ?? []).some((message: any) => message.ts === 2),
				),
			)
			assert.equal(stub.control.failedPosts, 1, "the failing post was never attempted")
			assert.ok(arrived, "the change was lost after the failed post")
		} finally {
			await manager.dispose()
			await stub.close()
		}
	})

	it("applies Approve or Deny only to the request still waiting", async () => {
		const stub = await startChatRelayStub()
		const manager = freshManager()
		relay.url = stub.url
		relay.key = "test-key"
		relay.pollIntervalMs = 40
		store.shared = ["chat-0001"]
		const { access, calls } = fakeChat([
			{ ts: 4, type: "ask", ask: "command", text: "ls", partial: false },
			{ ts: 5, type: "ask", ask: "command", text: "pwd", partial: false },
		])
		manager.setChatAccess(access)
		try {
			await manager.toggle()
			// A late tap on an older request is ignored.
			stub.deviceSends("chat-0001", "decision", { ts: 4, approve: true })
			// A tap on the request still waiting is applied.
			stub.deviceSends("chat-0001", "decision", { ts: 5, approve: false })
			assert.ok(await waitUntil(() => calls.decide.length > 0), "no decision was applied")
			await new Promise((resolve) => setTimeout(resolve, 200))
			assert.deepEqual(calls.decide, [{ ts: 5, approve: false }])
		} finally {
			await manager.dispose()
			await stub.close()
		}
	})

	it("applies a page's events one at a time, in the order they arrived", async () => {
		const stub = await startChatRelayStub()
		const manager = freshManager()
		relay.url = stub.url
		relay.key = "test-key"
		relay.pollIntervalMs = 40
		store.shared = ["chat-0001"]
		const { access, calls } = fakeChat([{ ts: 1, type: "say", say: "text", text: "ready" }])
		// Stored the way VS Code stores them: a flip reads the whole settings, changes one switch and
		// writes the whole settings back, and the read takes a moment.
		let settings: Record<string, boolean> = {
			readFiles: false,
			editFiles: false,
			executeSafeCommands: false,
			useBrowser: false,
			useMcp: false,
		}
		const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
		access.getAutoApprove = async () => ({ ...settings })
		access.setAutoApprove = async (action: string, enabled: boolean) => {
			const current = { ...settings }
			await pause(30)
			settings = { ...current, [action]: enabled }
		}
		// The first message takes longer to hand to the chat than the second.
		access.send = async (_chatId: string, text: string) => {
			await pause(text === "first" ? 60 : 0)
			calls.send.push(text)
		}
		manager.setChatAccess(access)
		try {
			await manager.toggle()
			// All of these reach the extension in one poll, as rapid taps on a page do.
			for (const action of Object.keys(settings)) {
				stub.deviceSends("chat-0001", "autoApprove", { action, enabled: true })
			}
			stub.deviceSends("chat-0001", "message", { text: "first" })
			stub.deviceSends("chat-0001", "message", { text: "second" })
			await waitUntil(() => calls.send.length === 2 && Object.values(settings).every(Boolean), 3000)
			await pause(200)
			assert.deepEqual(
				{ settings, messages: calls.send },
				{
					settings: { readFiles: true, editFiles: true, executeSafeCommands: true, useBrowser: true, useMcp: true },
					messages: ["first", "second"],
				},
			)
		} finally {
			await manager.dispose()
			await stub.close()
		}
	})
})
