import { Logger } from "@/shared/services/Logger"

export type RelayLinkState = "idle" | "connecting" | "connected" | "failed"

export type RelayLinkStatus = {
	state: RelayLinkState
	host: string
	error: string
	lastAttemptAt: number
	consecutiveFailures: number
	nextPollInMs: number
}

export type RelayEvent = { kind: string; payload: unknown; sentAt: number; seq?: number }

export type RelayLinkOptions = {
	/** Where the user installed the relay, e.g. https://example.com/relay */
	url: string
	/** The value written into the bundle's relay.key file. */
	key: string
	/** The version this extension is. A relay that reports any other version is refused. */
	extensionVersion: string
	pollIntervalMs?: number
	/** An event a paired device sent into one shared chat. */
	onChatEvent?: (chatId: string, event: RelayEvent) => void
	/** A gap: the relay dropped events for one chat before they were read. */
	onChatGap?: (chatId: string, dropped: number) => void
	onStatus?: (status: RelayLinkStatus) => void
}

/** One shared chat as the relay lists it: the chat's own session id, and its name. */
export type RelaySharedChat = { id: string; name: string }

export type RelayDevice = { id: string; name: string; createdAt: number; lastUsedAt: number }

const DEFAULT_POLL_MS = 1500
/** Reported while the relay is reached but could not save a chat's data. */
export const RELAY_CANNOT_SAVE = "relay_save_failed: the relay could not save its data"

/** Past this many consecutive failures the link stops retrying and reports itself unreachable. */
const FAILURE_CEILING = 5
const BACKOFF_CEILING_MS = 30_000

const isLocalHost = (hostname: string) =>
	hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"

/**
 * The relay is reached over the public internet, so a plain http relay would carry the key in the
 * clear. Loopback is allowed because that is where the relay is tested before anyone installs it.
 */
export function validateRelayUrl(rawUrl: string): { url: URL | null; error: string } {
	let parsed: URL
	try {
		parsed = new URL(rawUrl)
	} catch (_error) {
		return { url: null, error: "not_a_url" }
	}
	if (parsed.protocol === "https:") {
		return { url: parsed, error: "" }
	}
	if (parsed.protocol === "http:" && isLocalHost(parsed.hostname)) {
		return { url: parsed, error: "" }
	}
	return { url: null, error: parsed.protocol === "http:" ? "relay_requires_https" : "unsupported_protocol" }
}

export class RelayLink {
	private readonly url: URL
	private readonly key: string
	private readonly extensionVersion: string
	private readonly pollIntervalMs: number
	private readonly onChatEvent?: (chatId: string, event: RelayEvent) => void
	private readonly onChatGap?: (chatId: string, dropped: number) => void
	private readonly onStatus?: (status: RelayLinkStatus) => void

	private timer: NodeJS.Timeout | null = null
	/** Shared chats by id, each with the inbound cursor the next poll continues from. */
	private chats = new Map<string, { name: string; cursor: number; registeredName: string | null }>()
	private status: RelayLinkStatus
	private stopped = false

	constructor(options: RelayLinkOptions) {
		const { url, error } = validateRelayUrl(options.url)
		if (!url) {
			throw new Error(`Relay URL rejected (${error}): ${options.url}`)
		}
		this.url = url
		this.key = options.key
		this.extensionVersion = options.extensionVersion
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS
		this.onChatEvent = options.onChatEvent
		this.onChatGap = options.onChatGap
		this.onStatus = options.onStatus
		this.status = {
			state: "idle",
			host: url.host,
			error: "",
			lastAttemptAt: 0,
			consecutiveFailures: 0,
			nextPollInMs: this.pollIntervalMs,
		}
	}

	private report(patch: Partial<RelayLinkStatus>): void {
		this.status = { ...this.status, ...patch }
		this.onStatus?.(this.status)
	}

	currentStatus(): RelayLinkStatus {
		return { ...this.status }
	}

	private headers(): Record<string, string> {
		return { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" }
	}

	/**
	 * One request to the relay, answered in JSON. A host's bot protection can answer with an HTML
	 * verification page instead; that is named as its own failure rather than reported as bad JSON.
	 */
	private async request<T>(failurePrefix: string, url: string, init: RequestInit): Promise<T> {
		const response = await fetch(url, init)
		const type = response.headers.get("content-type") ?? ""
		if (!type.includes("application/json")) {
			throw new Error(
				`relay_host_challenge: the host answered with a verification page instead of the relay (${failurePrefix}_${response.status})`,
			)
		}
		if (!response.ok) {
			throw new Error(`${failurePrefix}_${response.status}`)
		}
		return (await response.json()) as T
	}

	/** The folder the user named, without a trailing slash or a trailing `index.php`. */
	private folder(): string {
		return this.url.pathname.replace(/\/+$/, "").replace(/\/index\.php$/i, "")
	}

	/**
	 * Every relay route goes through the file itself, as `<folder>/index.php?route=health`. A path such
	 * as `<folder>/health` is not a file, and a web server sends it to `index.php` only when a rewrite
	 * rule says so; some hosts read rewrite rules only from the document root, so no rule inside the
	 * relay's folder could ever make that address work. The query string needs no rule on any host.
	 */
	private route(...segments: string[]): string {
		const target = new URL(`${this.folder()}/index.php`, this.url.origin)
		target.searchParams.set("route", segments.join("/"))
		return target.toString()
	}

	/** A file under the relay's folder, requested directly rather than through `index.php`. */
	private fileUrl(...segments: string[]): string {
		return new URL(`${this.folder()}/${segments.join("/")}`, this.url.origin).toString()
	}

	/** GET /health needs no credential, and it is where the version handshake happens. */
	private async checkHealth(): Promise<void> {
		const body = await this.request<{ version?: string }>("relay_health", this.route("health"), { method: "GET" })
		if (body.version !== this.extensionVersion) {
			throw new Error(
				`relay_version_mismatch: relay is ${body.version ?? "unknown"}, this extension is ${this.extensionVersion}`,
			)
		}
	}

	/** Registers a shared chat under its own id, so its address on the relay never changes. */
	private async registerChat(chatId: string, name: string): Promise<void> {
		await this.request("relay_session_registration", this.route("session"), {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({ id: chatId, name }),
		})
	}

	/** Brings the relay's list of shared chats in line with this machine's. */
	private async syncChats(): Promise<void> {
		for (const [chatId, chat] of this.chats) {
			if (chat.registeredName !== chat.name) {
				await this.registerChat(chatId, chat.name)
				chat.registeredName = chat.name
			}
		}
	}

	/**
	 * The chats paired devices may see. A chat dropped from the list is removed from the relay; a new
	 * one, or a renamed one, is registered on the next poll.
	 */
	async setSharedChats(chats: RelaySharedChat[]): Promise<void> {
		const wanted = new Map(chats.map((chat) => [chat.id, chat.name]))
		for (const chatId of [...this.chats.keys()]) {
			if (!wanted.has(chatId)) {
				this.chats.delete(chatId)
				if (this.status.state === "connected") {
					await this.request("relay_session_remove", this.route("session", chatId, "remove"), {
						method: "POST",
						headers: this.headers(),
					}).catch((error) => Logger.warn(`Relay could not remove chat ${chatId}: ${String(error)}`))
				}
			}
		}
		for (const [chatId, name] of wanted) {
			const existing = this.chats.get(chatId)
			if (existing) {
				existing.name = name
			} else {
				this.chats.set(chatId, { name, cursor: 0, registeredName: null })
			}
		}
	}

	/** A single-use code a device types, or reads from a QR code, to pair with this relay. */
	async createPairingCode(): Promise<{ code: string; expiresInSeconds: number }> {
		return this.request("relay_pair_code", this.route("pair-code"), { method: "POST", headers: this.headers() })
	}

	async listDevices(): Promise<RelayDevice[]> {
		const body = await this.request<{ devices?: RelayDevice[] }>("relay_devices", this.route("devices"), {
			method: "GET",
			headers: this.headers(),
		})
		return body.devices ?? []
	}

	async removeDevice(deviceId: string): Promise<void> {
		await this.request("relay_device_remove", this.route("devices", deviceId, "remove"), {
			method: "POST",
			headers: this.headers(),
		})
	}

	/** Where the relay keeps its data on the server, from its key-only status route. */
	async dataLocation(): Promise<string> {
		const body = await this.request<{ dataDir?: string }>("relay_status", this.route("status"), {
			method: "GET",
			headers: this.headers(),
		})
		return body.dataDir ?? ""
	}

	/** The relay's own address, where a person opens the chat page. */
	pageUrl(): string {
		return new URL(`${this.folder()}/`, this.url.origin).toString()
	}

	/**
	 * Ask the relay for its own data file from outside. The relay cannot do this check itself — a file
	 * requesting its own server deadlocks on a single-worker PHP server, which is the shape shared
	 * hosting has — but the machine dialing out can, and it is the machine whose credential and session
	 * records would be exposed.
	 *
	 * Only a 200 disqualifies the relay. 403 and 404 are both proof the data is not reachable, and any
	 * other answer says something about the server rather than about the placement.
	 */
	private async checkDataNotExposed(): Promise<void> {
		const response = await fetch(this.fileUrl("data", "config.json"), { method: "GET" })
		if (response.status === 200) {
			throw new Error("relay_exposed: the relay's data directory is readable over the web")
		}
	}

	/**
	 * Health check, version handshake, exposure check, session registration, then the poll loop.
	 * A failure at any step is reported as a named state rather than left as a spinner.
	 */
	async start(): Promise<RelayLinkStatus> {
		this.stopped = false
		this.report({ state: "connecting", error: "", lastAttemptAt: Date.now(), consecutiveFailures: 0 })
		try {
			await this.checkHealth()
			await this.checkDataNotExposed()
			for (const chat of this.chats.values()) {
				chat.registeredName = null
			}
			await this.syncChats()
			this.report({ state: "connected", error: "", consecutiveFailures: 0, lastAttemptAt: Date.now() })
			this.scheduleNextPoll(this.pollIntervalMs)
			return this.currentStatus()
		} catch (error) {
			return this.handleFailure(error)
		}
	}

	private handleFailure(error: unknown): RelayLinkStatus {
		const message = error instanceof Error ? error.message : String(error)
		const failures = this.status.consecutiveFailures + 1
		const backoff = Math.min(this.pollIntervalMs * 2 ** (failures - 1), BACKOFF_CEILING_MS)
		Logger.warn(`Relay link failed (${this.status.host}): ${message}`)
		this.report({
			state: "failed",
			error: message,
			lastAttemptAt: Date.now(),
			consecutiveFailures: failures,
			nextPollInMs: backoff,
		})
		if (!this.stopped && failures < FAILURE_CEILING) {
			this.scheduleNextPoll(backoff)
		} else if (this.timer) {
			clearTimeout(this.timer)
			this.timer = null
			this.report({
				error: `unreachable: ${this.status.host}, last attempt ${new Date(this.status.lastAttemptAt).toISOString()}`,
			})
		}
		return this.currentStatus()
	}

	private scheduleNextPoll(delayMs: number): void {
		if (this.timer) {
			clearTimeout(this.timer)
		}
		// Jitter keeps several sessions on one relay from synchronizing onto the same request window.
		const jittered = delayMs + Math.floor(Math.random() * 250)
		this.timer = setTimeout(() => {
			void this.pollOnce()
		}, jittered)
		this.timer.unref?.()
		this.report({ nextPollInMs: jittered })
	}

	/**
	 * One request for every shared chat. With no chat shared, the poll is a health check, so the state
	 * the popover shows stays true.
	 */
	private async pollOnce(): Promise<void> {
		if (this.stopped) {
			return
		}
		try {
			await this.syncChats()
			let cannotSave = false
			if (this.chats.size === 0) {
				await this.checkHealth()
			} else {
				const cursors: Record<string, number> = {}
				for (const [chatId, chat] of this.chats) {
					cursors[chatId] = chat.cursor
				}
				const body = await this.request<{
					sessions?: Record<string, { events?: RelayEvent[]; cursor?: number; dropped?: number; error?: string }>
					missing?: string[]
				}>("relay_poll", this.route("poll"), {
					method: "POST",
					headers: this.headers(),
					body: JSON.stringify({ cursors }),
				})
				for (const chatId of body.missing ?? []) {
					// The relay forgot this chat (it expired, or the relay was reinstalled): register it again.
					const chat = this.chats.get(chatId)
					if (chat) {
						chat.registeredName = null
						chat.cursor = 0
					}
				}
				for (const [chatId, result] of Object.entries(body.sessions ?? {})) {
					// The relay could not empty this chat's queue; it handed out nothing and keeps the
					// events for the next poll. Reported, so the failure is not silent.
					if (result.error === "relay_save_failed") {
						cannotSave = true
					}
					const chat = this.chats.get(chatId)
					if (!chat) {
						continue
					}
					chat.cursor = result.cursor ?? chat.cursor
					if (result.dropped && result.dropped > 0) {
						this.onChatGap?.(chatId, result.dropped)
					}
					for (const event of result.events ?? []) {
						this.onChatEvent?.(chatId, event)
					}
				}
			}
			this.report({
				state: "connected",
				error: cannotSave ? RELAY_CANNOT_SAVE : "",
				consecutiveFailures: 0,
				lastAttemptAt: Date.now(),
			})
			this.scheduleNextPoll(this.pollIntervalMs)
		} catch (error) {
			this.handleFailure(error)
		}
	}

	/** Pushes events from one shared chat up for its paired devices to read. */
	async post(chatId: string, events: RelayEvent[]): Promise<boolean> {
		if (this.status.state !== "connected" || !this.chats.has(chatId) || events.length === 0) {
			return false
		}
		try {
			await this.request("relay_post", this.route("session", chatId, "outbound"), {
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify({ events }),
			})
			return true
		} catch (error) {
			Logger.warn(`Relay post failed (${this.status.host}): ${error instanceof Error ? error.message : String(error)}`)
			return false
		}
	}

	stop(): void {
		this.stopped = true
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = null
		}
		this.report({ state: "idle", nextPollInMs: this.pollIntervalMs })
	}
}
