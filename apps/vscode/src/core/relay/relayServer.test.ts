import { strict as assert } from "node:assert"
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, it } from "vitest"
import { buildRelayInstaller, createInstallToken } from "./relayBundle"

/**
 * The relay's own behaviour, proven against the generated index.php running under PHP's built-in
 * server: pairing, devices, and which side may read and write each direction of a chat's queues.
 * Skipped where no PHP is installed.
 */
const hasPhp = (() => {
	try {
		execFileSync("php", ["-v"], { stdio: "ignore" })
		return true
	} catch {
		return false
	}
})()

// Minted the way Get installer mints it, so no fixed token sits in the repository.
const TOKEN = createInstallToken()

const freePort = () =>
	new Promise<number>((resolve) => {
		const server = createServer()
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number }
			server.close(() => resolve(port))
		})
	})

describe.skipIf(!hasPhp)("relay index.php under PHP", () => {
	let root = ""
	let dataDir = ""
	let php: ChildProcess | undefined
	let base = ""
	let key = ""

	const call = async (
		route: string,
		options: { method?: string; body?: unknown; key?: string; cookie?: string; query?: string } = {},
	) => {
		const headers: Record<string, string> = {}
		if (options.key) {
			headers.Authorization = `Bearer ${options.key}`
		}
		if (options.cookie) {
			headers.Cookie = options.cookie
		}
		if (options.body !== undefined) {
			headers["Content-Type"] = "application/json"
		}
		const response = await fetch(`${base}/relay/index.php?route=${encodeURIComponent(route)}${options.query ?? ""}`, {
			method: options.method ?? "GET",
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		})
		const text = await response.text()
		return { status: response.status, body: text ? JSON.parse(text) : {}, setCookie: response.headers.getSetCookie() }
	}

	/** Pairs a new device and answers the cookie it was given. */
	const pairDevice = async () => {
		const code = await call("pair-code", { method: "POST", key })
		assert.equal(code.status, 200)
		const paired = await call("pair", { method: "POST", body: { code: code.body.code, name: "test device" } })
		assert.equal(paired.status, 200, JSON.stringify(paired.body))
		const cookie = paired.setCookie.find((line) => line.startsWith("cline_cubed_device="))
		assert.ok(cookie, "pairing set no device cookie")
		return { code: code.body.code as string, cookie: cookie.split(";")[0] }
	}

	beforeAll(async () => {
		root = mkdtempSync(path.join(tmpdir(), "relay-php-"))
		dataDir = path.join(root, "data-outside")
		mkdirSync(path.join(root, "relay"))
		mkdirSync(dataDir)
		writeFileSync(path.join(root, "relay", "index.php"), buildRelayInstaller("9.9.9", TOKEN))
		const port = await freePort()
		base = `http://127.0.0.1:${port}`
		php = spawn("php", ["-S", `127.0.0.1:${port}`, "-t", root], {
			env: { ...process.env, CLINE_RELAY_DATA_DIR: dataDir },
			stdio: "ignore",
		})
		const deadline = Date.now() + 5000
		while (Date.now() < deadline) {
			try {
				await fetch(`${base}/relay/index.php?route=health`)
				break
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 50))
			}
		}
		const install = await fetch(`${base}/relay/`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: `token=${TOKEN}`,
		})
		assert.equal(install.status, 200)
		key = readFileSync(path.join(dataDir, "relay.key"), "utf8").trim()
	})

	afterAll(() => {
		php?.kill()
		rmSync(root, { recursive: true, force: true })
	})

	it("trades a pairing code for a device once, and refuses the same code a second time", async () => {
		const { code, cookie } = await pairDevice()
		const chats = await call("chats", { cookie })
		assert.equal(chats.status, 200)
		const again = await call("pair", { method: "POST", body: { code } })
		assert.equal(again.status, 403)
		assert.equal(again.body.error, "pair_code_invalid")
	})

	it("refuses a pairing code past its ten minutes", async () => {
		const code = await call("pair-code", { method: "POST", key })
		const file = path.join(dataDir, "pair-codes.json")
		const codes = JSON.parse(readFileSync(file, "utf8")) as Array<{ expiresAt: number }>
		writeFileSync(file, JSON.stringify(codes.map((entry) => ({ ...entry, expiresAt: Math.floor(Date.now() / 1000) - 1 }))))
		const paired = await call("pair", { method: "POST", body: { code: code.body.code } })
		assert.equal(paired.status, 403)
	})

	it("refuses a device once it is removed", async () => {
		const { cookie } = await pairDevice()
		const devices = await call("devices", { key })
		const newest = devices.body.devices[devices.body.devices.length - 1]
		const removed = await call(`devices/${newest.id}/remove`, { method: "POST", key })
		assert.equal(removed.status, 200)
		const chats = await call("chats", { cookie })
		assert.equal(chats.status, 401)
		assert.equal(chats.body.error, "not_paired")
	})

	it("keeps each direction of a chat's queues to its own side", async () => {
		const { cookie } = await pairDevice()
		assert.equal((await call("session", { method: "POST", key, body: { id: "chat-0001", name: "A chat" } })).status, 200)
		const outboundEvent = { events: [{ kind: "messages", payload: { messages: [] }, sentAt: 1 }] }
		const inboundEvent = { events: [{ kind: "message", payload: { text: "from the phone" }, sentAt: 2 }] }

		// A device may not write the machine's direction, nor read the machine's own queue.
		assert.equal((await call("session/chat-0001/outbound", { method: "POST", cookie, body: outboundEvent })).status, 403)
		assert.equal((await call("session/chat-0001/inbound", { cookie, query: "&cursor=0" })).status, 403)

		// The machine writes outbound; every device can read it, and reading leaves it for the others.
		assert.equal((await call("session/chat-0001/outbound", { method: "POST", key, body: outboundEvent })).status, 200)
		const firstRead = await call("session/chat-0001/outbound", { cookie, query: "&cursor=0" })
		const secondRead = await call("session/chat-0001/outbound", { cookie, query: "&cursor=0" })
		assert.equal(firstRead.body.events.length, 1)
		assert.equal(secondRead.body.events.length, 1)

		// The device writes inbound; the machine's combined poll takes it once.
		assert.equal((await call("session/chat-0001/inbound", { method: "POST", cookie, body: inboundEvent })).status, 200)
		const poll = await call("poll", { method: "POST", key, body: { cursors: { "chat-0001": 0 } } })
		assert.equal(poll.body.sessions["chat-0001"].events[0].payload.text, "from the phone")
		const pollAgain = await call("poll", { method: "POST", key, body: { cursors: { "chat-0001": 0 } } })
		assert.equal(pollAgain.body.sessions["chat-0001"].events.length, 0)
	})

	it("refuses an unpaired browser everything but the pairing check", async () => {
		const pairing = await call("pairing")
		assert.equal(pairing.status, 200)
		assert.equal(pairing.body.paired, false)
		assert.equal((await call("chats")).status, 401)
	})
})

/**
 * A host answers requests in parallel, so the page's posts and reads land at the same moment as the
 * extension's posts and polls. Every event either side sends must still arrive exactly once.
 */
describe.skipIf(!hasPhp)("relay index.php under PHP answering requests in parallel", () => {
	let root = ""
	let dataDir = ""
	let php: ChildProcess | undefined
	let base = ""
	let key = ""

	const call = async (
		route: string,
		options: { method?: string; body?: unknown; key?: string; cookie?: string; query?: string } = {},
	) => {
		const headers: Record<string, string> = {}
		if (options.key) {
			headers.Authorization = `Bearer ${options.key}`
		}
		if (options.cookie) {
			headers.Cookie = options.cookie
		}
		if (options.body !== undefined) {
			headers["Content-Type"] = "application/json"
		}
		const response = await fetch(`${base}/relay/index.php?route=${encodeURIComponent(route)}${options.query ?? ""}`, {
			method: options.method ?? "GET",
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		})
		const text = await response.text()
		return { status: response.status, body: text ? JSON.parse(text) : {}, setCookie: response.headers.getSetCookie() }
	}

	beforeAll(async () => {
		root = mkdtempSync(path.join(tmpdir(), "relay-php-parallel-"))
		dataDir = path.join(root, "data-outside")
		mkdirSync(path.join(root, "relay"))
		mkdirSync(dataDir)
		writeFileSync(path.join(root, "relay", "index.php"), buildRelayInstaller("9.9.9", TOKEN))
		const port = await freePort()
		base = `http://127.0.0.1:${port}`
		php = spawn("php", ["-S", `127.0.0.1:${port}`, "-t", root], {
			env: { ...process.env, CLINE_RELAY_DATA_DIR: dataDir, PHP_CLI_SERVER_WORKERS: "4" },
			stdio: "ignore",
			// Its own process group, so stopping the group stops the workers PHP forks as well.
			detached: true,
		})
		const deadline = Date.now() + 5000
		while (Date.now() < deadline) {
			try {
				await fetch(`${base}/relay/index.php?route=health`)
				break
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 50))
			}
		}
		const install = await fetch(`${base}/relay/`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: `token=${TOKEN}`,
		})
		assert.equal(install.status, 200)
		key = readFileSync(path.join(dataDir, "relay.key"), "utf8").trim()
	})

	afterAll(() => {
		// Stopping only the main process would leave its four workers running.
		if (php?.pid) {
			try {
				process.kill(-php.pid, "SIGTERM")
			} catch {
				php.kill()
			}
		}
		rmSync(root, { recursive: true, force: true })
	})

	it("delivers every event exactly once when both sides post and read at the same moment", async () => {
		const code = await call("pair-code", { method: "POST", key })
		const paired = await call("pair", { method: "POST", body: { code: code.body.code, name: "parallel device" } })
		const cookie = (paired.setCookie.find((line) => line.startsWith("cline_cubed_device=")) ?? "").split(";")[0]
		assert.ok(cookie, "pairing set no device cookie")
		assert.equal(
			(await call("session", { method: "POST", key, body: { id: "chat-parallel", name: "Parallel" } })).status,
			200,
		)

		const ROUNDS = 60
		const received: number[] = []
		let pollCursor = 0
		const poll = async () => {
			const result = await call("poll", { method: "POST", key, body: { cursors: { "chat-parallel": pollCursor } } })
			const session = result.body.sessions?.["chat-parallel"]
			for (const event of session?.events ?? []) {
				received.push(event.payload.n)
			}
			pollCursor = Math.max(pollCursor, session?.cursor ?? 0)
		}

		// Each round fires, all at once: a page post, a page read, an extension post and an extension poll.
		// Rounds go in batches of four, 16 requests at a time, so the four workers answer every request
		// rather than refusing connections; a failure is then a lost event, never a refused request.
		const BATCH = 4
		const failed: string[] = []
		const acceptedFromPage: number[] = []
		const acceptedFromExtension: number[] = []
		const checked = (request: Promise<{ status: number }>, what: string, accepted?: () => void) =>
			request.then((result) => {
				if (result.status !== 200) {
					failed.push(`${what} answered ${result.status}`)
				} else {
					accepted?.()
				}
			})
		for (let start = 0; start < ROUNDS; start += BATCH) {
			const requests: Promise<unknown>[] = []
			for (let n = start; n < Math.min(ROUNDS, start + BATCH); n++) {
				requests.push(
					checked(
						call("session/chat-parallel/inbound", {
							method: "POST",
							cookie,
							body: { events: [{ kind: "message", payload: { n }, sentAt: n }] },
						}),
						`page post ${n}`,
						() => acceptedFromPage.push(n),
					),
					checked(call("session/chat-parallel/outbound", { cookie, query: "&cursor=0" }), `page read ${n}`),
					checked(
						call("session/chat-parallel/outbound", {
							method: "POST",
							key,
							body: { events: [{ kind: "update", payload: { n }, sentAt: n }] },
						}),
						`extension post ${n}`,
						() => acceptedFromExtension.push(n),
					),
					poll(),
				)
			}
			await Promise.all(requests)
		}
		await poll()
		const outbound = await call("session/chat-parallel/outbound", { cookie, query: "&cursor=0" })
		const readable = ((outbound.body.events ?? []) as Array<{ payload: { n: number } }>).map((event) => event.payload.n)

		// Every request answered, and every event the relay accepted arrives exactly once: reported
		// together so one run shows refused requests and lost events side by side.
		const sorted = (values: number[]) => [...values].sort((a, b) => a - b)
		assert.deepEqual(
			{
				refusedRequests: failed,
				pageEventsReceivedByTheExtension: sorted(received),
				extensionUpdatesReadableByThePage: sorted(readable),
			},
			{
				refusedRequests: [],
				pageEventsReceivedByTheExtension: sorted(acceptedFromPage),
				extensionUpdatesReadableByThePage: sorted(acceptedFromExtension),
			},
			`refused ${failed.length}; the extension received ${received.length} of ${acceptedFromPage.length} accepted page events; the page can read ${readable.length} of ${acceptedFromExtension.length} accepted updates`,
		)
	})
})

const runsAsRoot = typeof process.getuid === "function" && process.getuid() === 0

/**
 * A save the host refuses (a full disk, a folder the web server cannot write) is answered as a
 * failure, so neither side is told an event was stored when it was not. Skipped as root, where
 * folder permissions do not apply.
 */
describe.skipIf(!hasPhp || runsAsRoot)("relay index.php when its data folder cannot be written", () => {
	let root = ""
	let dataDir = ""
	let dataDirMode = 0
	let php: ChildProcess | undefined
	let base = ""
	let key = ""

	const call = async (
		route: string,
		options: { method?: string; body?: unknown; key?: string; cookie?: string; query?: string } = {},
	) => {
		const headers: Record<string, string> = {}
		if (options.key) {
			headers.Authorization = `Bearer ${options.key}`
		}
		if (options.cookie) {
			headers.Cookie = options.cookie
		}
		if (options.body !== undefined) {
			headers["Content-Type"] = "application/json"
		}
		const response = await fetch(`${base}/relay/index.php?route=${encodeURIComponent(route)}${options.query ?? ""}`, {
			method: options.method ?? "GET",
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		})
		const text = await response.text()
		return { status: response.status, body: text ? JSON.parse(text) : {}, setCookie: response.headers.getSetCookie() }
	}

	beforeAll(async () => {
		root = mkdtempSync(path.join(tmpdir(), "relay-php-savefail-"))
		dataDir = path.join(root, "data-outside")
		mkdirSync(path.join(root, "relay"))
		mkdirSync(dataDir)
		dataDirMode = statSync(dataDir).mode & 0o777
		writeFileSync(path.join(root, "relay", "index.php"), buildRelayInstaller("9.9.9", TOKEN))
		const port = await freePort()
		base = `http://127.0.0.1:${port}`
		php = spawn("php", ["-S", `127.0.0.1:${port}`, "-t", root], {
			env: { ...process.env, CLINE_RELAY_DATA_DIR: dataDir },
			stdio: "ignore",
		})
		const deadline = Date.now() + 5000
		while (Date.now() < deadline) {
			try {
				await fetch(`${base}/relay/index.php?route=health`)
				break
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 50))
			}
		}
		const install = await fetch(`${base}/relay/`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: `token=${TOKEN}`,
		})
		assert.equal(install.status, 200)
		key = readFileSync(path.join(dataDir, "relay.key"), "utf8").trim()
	})

	afterAll(() => {
		// Writable again before anything else, so a failed run cannot leave the folder locked.
		if (dataDir) {
			chmodSync(dataDir, dataDirMode)
		}
		php?.kill()
		rmSync(root, { recursive: true, force: true })
	})

	it("answers every save it could not make with 500, and stores nothing it refused", async () => {
		const code = await call("pair-code", { method: "POST", key })
		const paired = await call("pair", { method: "POST", body: { code: code.body.code, name: "save-fail device" } })
		const cookie = (paired.setCookie.find((line) => line.startsWith("cline_cubed_device=")) ?? "").split(";")[0]
		assert.ok(cookie, "pairing set no device cookie")
		assert.equal(
			(await call("session", { method: "POST", key, body: { id: "chat-savefail", name: "Save fail" } })).status,
			200,
		)
		const before = { events: [{ kind: "message", payload: { n: 0 }, sentAt: 0 }] }
		assert.equal((await call("session/chat-savefail/inbound", { method: "POST", cookie, body: before })).status, 200)
		assert.equal((await call("session/chat-savefail/outbound", { method: "POST", key, body: before })).status, 200)
		const deviceId = (await call("devices", { key })).body.devices[0].id as string

		// The folder can no longer be written: every save fails.
		chmodSync(dataDir, 0o500)
		const refused = { events: [{ kind: "message", payload: { n: 1 }, sentAt: 1 }] }
		const answer = (result: { status: number; body: { error?: string; events?: unknown[]; sessions?: unknown } }) =>
			`${result.status} ${result.body.error ?? "no error"}`
		const pagePost = await call("session/chat-savefail/inbound", { method: "POST", cookie, body: refused })
		const extensionPost = await call("session/chat-savefail/outbound", { method: "POST", key, body: refused })
		const pairCode = await call("pair-code", { method: "POST", key })
		const removal = await call(`devices/${deviceId}/remove`, { method: "POST", key })
		const lockedPoll = await call("poll", { method: "POST", key, body: { cursors: { "chat-savefail": 0 } } })
		const lockedPollEntry = lockedPoll.body.sessions?.["chat-savefail"]
		const lockedPollEvents = (lockedPollEntry?.events ?? []).length
		chmodSync(dataDir, dataDirMode)

		// Writable again: what was refused is not there, what was stored before is delivered once.
		const poll = await call("poll", { method: "POST", key, body: { cursors: { "chat-savefail": 0 } } })
		const inbound = (poll.body.sessions?.["chat-savefail"]?.events ?? []).map(
			(event: { payload: { n: number } }) => event.payload.n,
		)
		const outbound = (await call("session/chat-savefail/outbound", { cookie, query: "&cursor=0" })).body.events.map(
			(event: { payload: { n: number } }) => event.payload.n,
		)
		const stillPaired = (await call("chats", { cookie })).status

		assert.deepEqual(
			{
				pagePost: answer(pagePost),
				extensionPost: answer(extensionPost),
				pairCode: answer(pairCode),
				deviceRemoval: answer(removal),
				// One poll carries every shared chat, so a chat whose save fails fails on its own.
				poll: `${lockedPoll.status}, chat entry ${lockedPollEntry?.error ?? "no error"}, ${lockedPollEvents} events handed out`,
				pageEventsDeliveredAfterwards: inbound,
				extensionUpdatesReadableAfterwards: outbound,
				deviceStillPaired: stillPaired,
			},
			{
				pagePost: "500 relay_save_failed",
				extensionPost: "500 relay_save_failed",
				pairCode: "500 relay_save_failed",
				deviceRemoval: "500 relay_save_failed",
				poll: "200, chat entry relay_save_failed, 0 events handed out",
				pageEventsDeliveredAfterwards: [0],
				extensionUpdatesReadableAfterwards: [0],
				deviceStillPaired: 200,
			},
		)
	})
})
