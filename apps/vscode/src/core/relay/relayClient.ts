import { RELAY_UNREACHABLE_PREFIX } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { chatDisplayCodeFor, RELAY_PROTOCOL } from "./relayBundle"

export type RelayLinkState = "idle" | "connecting" | "connected" | "failed"

export type RelayLinkStatus = {
	state: RelayLinkState
	host: string
	error: string
	lastAttemptAt: number
	consecutiveFailures: number
	nextPollInMs: number
	/** Something about the relay worth telling the person while it works, such as being out of date; "" for nothing. */
	notice: string
	/** What the notice is about, so it can be titled without reading its text; "" with no notice. */
	noticeKind: RelayNoticeKind
	/** The version of Cline Cubed that wrote the relay's index.php, as `health` reports it; "" until known. */
	installedVersion: string
	/** The version of the chat display code the relay serves; "" until known. */
	displayVersion: string
	/** Where that code came from: "sent" (auto-updated by Cline Cubed) or "built-in" (the installed base); "" until known. */
	displaySource: string
}

/** update-needed: a relay from before automatic updates; behind: older, with automatic updates off;
 *  update-failed: sending it the current chat display code failed. */
export type RelayNoticeKind = "" | "update-needed" | "behind" | "update-failed"

/** What `health` says about the relay. A relay from before protocol numbers reports neither display field. */
type RelayHealth = { version?: string; protocol?: number; displayVersion?: string; displaySource?: string }

const UPLOAD_ONCE = "Use Get installer and upload the new index.php over the old one; your relay key and paired devices stay."

export type RelayEvent = { kind: string; payload: unknown; sentAt: number; seq?: number }

export type RelayLinkOptions = {
	/** Where the user installed the relay, e.g. https://example.com/relay */
	url: string
	/** The value written into the bundle's relay.key file. */
	key: string
	/** The version this extension is. A relay serving older chat display code is sent this version's. */
	extensionVersion: string
	/** Send the relay this version's chat display code when its copy is older. On unless set false. */
	autoUpdate?: boolean
	pollIntervalMs?: number
	/** An event a paired device sent into one shared chat. */
	onChatEvent?: (chatId: string, event: RelayEvent) => void
	/** A gap: the relay dropped events for one chat before they were read. */
	onChatGap?: (chatId: string, dropped: number) => void
	onStatus?: (status: RelayLinkStatus) => void
}

/** One shared chat as the relay lists it: the chat's own session id, and its name. */
export type RelaySharedChat = { id: string; name: string }

/**
 * A paired device as the relay lists it. `lastSeenAt` is when it last made a request, kept to the minute; a
 * relay from before 4.1.32's device lights reports no such field, and the extension then uses `lastUsedAt`.
 */
export type RelayDevice = { id: string; name: string; createdAt: number; lastUsedAt: number; lastSeenAt?: number }

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

/**
 * Every relay route goes through the file itself, as `<folder>/index.php?route=health`. A path such
 * as `<folder>/health` is not a file, and a web server sends it to `index.php` only when a rewrite
 * rule says so; some hosts read rewrite rules only from the document root, so no rule inside the
 * relay's folder could ever make that address work. The query string needs no rule on any host.
 */
function relayRouteUrl(url: URL, ...segments: string[]): string {
	const folder = url.pathname.replace(/\/+$/, "").replace(/\/index\.php$/i, "")
	const target = new URL(`${folder}/index.php`, url.origin)
	target.searchParams.set("route", segments.join("/"))
	return target.toString()
}

/**
 * The host of a relay already installed at this address, or "" when none answers as installed. Get
 * installer uses it to show the steps for updating that relay beside the steps for a new install.
 * `health` needs no credential.
 */
export async function installedRelayHost(rawUrl: string): Promise<string> {
	const { url } = validateRelayUrl(rawUrl)
	if (!url) {
		return ""
	}
	try {
		const response = await fetch(relayRouteUrl(url, "health"), { method: "GET", signal: AbortSignal.timeout(5000) })
		if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/json")) {
			return ""
		}
		const body = (await response.json()) as { installed?: boolean }
		return body.installed === true ? url.host : ""
	} catch (error) {
		Logger.warn(
			`Could not ask the relay at ${url.host} whether it is installed: ${error instanceof Error ? error.message : String(error)}`,
		)
		return ""
	}
}

export class RelayLink {
	private readonly url: URL
	private readonly key: string
	private readonly extensionVersion: string
	private readonly autoUpdate: boolean
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
		this.autoUpdate = options.autoUpdate !== false
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
			notice: "",
			noticeKind: "",
			installedVersion: "",
			displayVersion: "",
			displaySource: "",
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
		let response: Response
		try {
			response = await fetch(url, init)
		} catch (error) {
			// No answer at all (refused, no route, name not found): named as its own failure, with the
			// system's own text and its code kept after the prefix for the relay details.
			const message = error instanceof Error ? error.message : String(error)
			const code = (error as { cause?: { code?: unknown } })?.cause?.code
			throw new Error(`${RELAY_UNREACHABLE_PREFIX}${message}${typeof code === "string" ? ` (${code})` : ""}`)
		}
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

	/** A relay route, through the file itself (see `relayRouteUrl`). */
	private route(...segments: string[]): string {
		return relayRouteUrl(this.url, ...segments)
	}

	/** A file under the relay's folder, requested directly rather than through `index.php`. */
	private fileUrl(...segments: string[]): string {
		return new URL(`${this.folder()}/${segments.join("/")}`, this.url.origin).toString()
	}

	/**
	 * GET /health needs no credential. A relay is refused only when its protocol, its routes and what
	 * they answer, differs from this extension's; a different Cline Cubed version alone is no reason. A
	 * relay from before protocol numbers reports none and speaks protocol 1.
	 */
	private async checkHealth(): Promise<RelayHealth> {
		const body = await this.request<RelayHealth>("relay_health", this.route("health"), { method: "GET" })
		const protocol = typeof body.protocol === "number" ? body.protocol : 1
		if (protocol !== RELAY_PROTOCOL) {
			throw new Error(
				`relay_protocol_mismatch: this relay (index.php v${body.version ?? "unknown"}) speaks relay protocol ${protocol}, and this Cline Cubed speaks ${RELAY_PROTOCOL}. ${UPLOAD_ONCE}`,
			)
		}
		return body
	}

	/**
	 * Keeps the relay's chat display code current. A relay from before protocol numbers cannot take it,
	 * so the person is told once how to bring it up to date; a current relay is sent this version's code
	 * when its copy is older, unless automatic updates are off, in which case it is said to be behind.
	 * A failed send leaves the relay working on the code it has.
	 */
	private async keepDisplayCurrent(health: RelayHealth): Promise<void> {
		// What the relay serves now, for the popover's relay details. A relay from before protocol numbers
		// serves the code built into its index.php.
		this.report({
			installedVersion: health.version ?? "",
			displayVersion: health.displayVersion ?? health.version ?? "",
			displaySource: health.displaySource ?? "built-in",
		})
		if (typeof health.protocol !== "number") {
			this.report({
				notice: `This relay's index.php (v${health.version ?? "unknown"}) predates automatic updates. ${UPLOAD_ONCE} After that, updates reach the relay on their own.`,
				noticeKind: "update-needed",
			})
			return
		}
		const current = health.displayVersion ?? health.version ?? ""
		if (current === this.extensionVersion) {
			this.report({ notice: "", noticeKind: "" })
			return
		}
		if (!this.autoUpdate) {
			this.report({
				notice: `The relay's chat display code is v${current || "unknown"}, and this Cline Cubed is v${this.extensionVersion}. Automatic relay updates are off: turn on "Keep the relay up to date automatically", or ${UPLOAD_ONCE.charAt(0).toLowerCase()}${UPLOAD_ONCE.slice(1)}`,
				noticeKind: "behind",
			})
			return
		}
		try {
			await this.request("relay_display", this.route("display"), {
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify({ version: this.extensionVersion, html: chatDisplayCodeFor(this.extensionVersion) }),
			})
			Logger.info(`Relay ${this.status.host}: chat display code updated from v${current} to v${this.extensionVersion}`)
			this.report({ notice: "", noticeKind: "", displayVersion: this.extensionVersion, displaySource: "sent" })
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			Logger.error(`Relay ${this.status.host}: could not update its chat display code: ${message}`)
			this.report({
				notice: `Could not update the relay's chat display code (${message}); it keeps working on v${current || "unknown"}.`,
				noticeKind: "update-failed",
			})
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
		return (body.devices ?? []).map((device) => ({ ...device, lastSeenAt: device.lastSeenAt ?? device.lastUsedAt }))
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
			const health = await this.checkHealth()
			await this.checkDataNotExposed()
			await this.keepDisplayCurrent(health)
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
				error: `${RELAY_UNREACHABLE_PREFIX}gave up retrying ${this.status.host}, last attempt ${new Date(this.status.lastAttemptAt).toISOString()}`,
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
