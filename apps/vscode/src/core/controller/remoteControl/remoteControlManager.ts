import {
	type HubServer,
	readRelaySettingsGlobally,
	readRemoteControlEnabledGlobally,
	readRemoteSharedChatsGlobally,
	setRemoteChatSharedGlobally,
	setRemoteControlEnabledGlobally,
} from "@cline/core"
import { splitConsentSuggestion } from "@shared/consentSuggestion"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { RemoteControlStatus } from "@shared/proto/cline/remote_control"
import { ExtensionRegistryInfo } from "@/registry"
import { Logger } from "@/shared/services/Logger"
import { type RelayDevice, type RelayEvent, RelayLink, type RelayLinkStatus, validateRelayUrl } from "../../relay/relayClient"

export type RemoteControlState = "disconnected" | "connecting" | "connected" | "failed"

/** Phase 1 keeps the hub on loopback. Nothing on this machine accepts an inbound connection. */
const REMOTE_CONTROL_HOST = "127.0.0.1"

/** How often a shared chat's changes are gathered and sent: at most twice a second per chat. */
const CHAT_PUMP_INTERVAL_MS = 500

/**
 * After an update is installed, remote control can start while another Hub still holds its lock,
 * which it keeps until its process exits. A start that finds the lock held waits this long for it,
 * trying again at this interval, before naming another window as the holder.
 */
const HUB_LOCK_WAIT_MS = 30_000
const HUB_LOCK_RETRY_MS = 2_000
const HUB_LOCK_WAITING = "Waiting for the previous session to close"
const HUB_LOCK_ELSEWHERE = "Remote control is already running in another VS Code window. Turn it off there, then turn it on here."

/** The Hub's refusal to start beside a live Hub (`HubLockHeldError` in `@cline/core`). */
function isHubLockHeld(error: unknown): boolean {
	return error instanceof Error && error.name === "HubLockHeldError"
}

/** A page that opens a chat gets at most this many of its most recent messages. */
const SNAPSHOT_MESSAGE_LIMIT = 300

/** What the extension gives this manager so a shared chat can be read and driven from a paired device. */
export type RemoteChatAccess = {
	/** The chat's messages as the chat panel holds them, whether the model is working, and its name. */
	view(chatId: string): Promise<
		| {
				messages: ClineMessage[]
				working: boolean
				title: string
				workspace: string
				contextUsed: number
				usage: { tokensIn: number; tokensOut: number; cacheWrites: number; cacheReads: number; cost: number }
				running: boolean
				isActive: boolean
		  }
		| undefined
	>
	/** The context window of the model in use, and the size at which automatic compaction fires. */
	contextLimits(): Promise<{ window: number; compactAt: number }>
	/** The total cost recorded across the chat history. */
	allChatsCost(): Promise<number>
	/** Compacts the chat, only when it is the chat active in VS Code; answers a notice when it cannot. */
	compact(chatId: string): Promise<string>
	/** A message from the page, delivered as the chat's own Send button delivers it. */
	send(chatId: string, text: string): Promise<void>
	/** Approve or deny the request with this timestamp, only while it is still the one waiting. */
	decide(chatId: string, ts: number, approve: boolean): Promise<void>
	/** A rename from the page, through the same path as VS Code's own rename. */
	rename(chatId: string, name: string): Promise<void>
	/** The auto-approve choices, which apply to every chat, as VS Code's own bar shows them. */
	getAutoApprove(): Promise<Record<string, boolean>>
	/** Turn one auto-approve choice on or off, through the same path VS Code's bar uses. */
	setAutoApprove(actionId: string, enabled: boolean): Promise<void>
	/** Whether Settings' suggested reply is on, which applies to every chat. */
	consentSuggestionEnabled(): Promise<boolean>
}

/** What a page is sent of one message. Images are never sent; the page shows "[image]" instead. */
type RemoteMessage = {
	ts: number
	type: string
	ask?: string
	say?: string
	text: string
	partial: boolean
	hasImages: boolean
}

function toRemoteMessage(message: ClineMessage): RemoteMessage {
	return {
		ts: message.ts,
		type: message.type,
		...(message.ask ? { ask: message.ask } : {}),
		...(message.say ? { say: message.say } : {}),
		text: message.text ?? "",
		partial: Boolean(message.partial),
		hasImages: Boolean(message.images?.length),
	}
}

function signature(message: RemoteMessage): string {
	return `${message.type}|${message.ask ?? ""}|${message.say ?? ""}|${message.partial ? 1 : 0}|${message.text}`
}

/**
 * The machine's remote-control mode: one local hub, one machine-wide choice.
 *
 * `state` reports `connected` only after the hub has actually been started or reused, so the
 * composer indicator can never read as up while the transport is still being made or has failed.
 * `enabled` is the stored choice and is reported separately, because a user can have the mode on
 * with the transport down — those are two different facts and the popover has to show both.
 */
export class RemoteControlManager {
	constructor(options: { lockWaitMs?: number; lockRetryMs?: number } = {}) {
		this.lockWaitMs = options.lockWaitMs ?? HUB_LOCK_WAIT_MS
		this.lockRetryMs = options.lockRetryMs ?? HUB_LOCK_RETRY_MS
	}

	private state: RemoteControlState = "disconnected"
	private enabled = false
	private server?: HubServer
	private error = ""
	private inFlight?: Promise<RemoteControlStatus>
	private restored = false
	/** Set while a start waits for another Hub's lock; Off or dispose clears it to end the wait. */
	private waitingForLock = false
	private readonly lockWaitMs: number
	private readonly lockRetryMs: number
	private relay?: RelayLink
	private relayStatus?: RelayLinkStatus
	private statusListener?: () => void
	private chatAccess?: RemoteChatAccess
	/** Where the relay keeps its data on the server, read once the link connects. */
	private relayDataDir = ""
	private pumpTimer?: NodeJS.Timeout
	/** Per shared chat: what was last sent, so only changes go out. */
	private sent = new Map<
		string,
		{ signatures: Map<number, string>; working: boolean; title: string; orderKey: string; autoKey: string; metaKey: string }
	>()

	/** Model limits and the all-chats cost change rarely; they are read at most every 30 seconds. */
	private shared: { at: number; limits?: { window: number; compactAt: number }; allCost?: number } = { at: 0 }

	private async sharedFigures(): Promise<{ limits?: { window: number; compactAt: number }; allCost?: number }> {
		if (this.chatAccess && Date.now() - this.shared.at > 30_000) {
			const [limits, allCost] = await Promise.all([
				this.chatAccess.contextLimits().catch(() => undefined),
				this.chatAccess.allChatsCost().catch(() => undefined),
			])
			this.shared = { at: Date.now(), limits, allCost }
		}
		return this.shared
	}

	/** What the page shows about a chat beyond its messages: context, usage and running commands. */
	private async meta(view: NonNullable<Awaited<ReturnType<RemoteChatAccess["view"]>>>, suggestion: string) {
		const figures = await this.sharedFigures()
		return {
			suggestion,
			context: { used: view.contextUsed, window: figures.limits?.window ?? 0, compactAt: figures.limits?.compactAt ?? 0 },
			usage: view.usage,
			allChatsCost: figures.allCost ?? 0,
			running: view.running,
			isActive: view.isActive,
		}
	}

	/**
	 * A chat as a page is shown it: the messages without the hidden suggested reply, and the reply
	 * that still counts, decided by the same rule VS Code's chat box uses; none while Settings has it
	 * off.
	 */
	private async forPage(messages: ClineMessage[]): Promise<{ messages: ClineMessage[]; suggestion: string }> {
		const split = splitConsentSuggestion(messages)
		const enabled = await this.chatAccess?.consentSuggestionEnabled().catch(() => false)
		return { messages: split.messages, suggestion: enabled ? (split.consentSuggestion ?? "") : "" }
	}

	/** The extension wires this once the controller exists. */
	setChatAccess(access: RemoteChatAccess): void {
		this.chatAccess = access
	}

	/** The extension wires this to its state broadcast, so a relay that drops mid-session is reported
	 *  rather than left for the next surface to discover. */
	setStatusListener(listener: () => void): void {
		this.statusListener = listener
	}

	private emit(): void {
		this.statusListener?.()
	}

	status(): RemoteControlStatus {
		return {
			state: this.state,
			enabled: this.enabled,
			url: this.server?.url ?? "",
			error: this.error,
			relayState: this.relayStatus?.state ?? "",
			relayError: this.relayStatus?.error ?? "",
			relayHost: this.relayStatus?.host ?? "",
			sharedChats: readRemoteSharedChatsGlobally(),
			relayPageUrl: this.relay?.pageUrl() ?? "",
			relayDataDir: this.relayStatus?.state === "connected" ? this.relayDataDir : "",
		}
	}

	/** Loads the stored choice and brings the hub up when the mode was left on. Runs once per process. */
	async ensureRestored(): Promise<RemoteControlStatus> {
		if (this.restored) {
			return this.status()
		}
		this.restored = true
		// Held as the request in flight, so a toggle during a restore that is waiting for the Hub's
		// lock joins it or ends it, rather than starting a second Hub beside it.
		this.inFlight = this.restore().finally(() => {
			this.inFlight = undefined
		})
		return this.inFlight
	}

	async restore(): Promise<RemoteControlStatus> {
		this.enabled = readRemoteControlEnabledGlobally()
		if (!this.enabled) {
			this.state = "disconnected"
			this.error = ""
			return this.status()
		}
		return this.start()
	}

	async toggle(): Promise<RemoteControlStatus> {
		return this.setEnabled(!this.enabled)
	}

	async setEnabled(enabled: boolean): Promise<RemoteControlStatus> {
		// Off while a start waits for the Hub's lock ends the wait: the start sees the choice is off
		// and settles as Off.
		if (this.inFlight && this.waitingForLock && !enabled) {
			this.enabled = false
			setRemoteControlEnabledGlobally(false)
			this.waitingForLock = false
			return this.inFlight
		}
		// A toggle whose result has not landed is not issued twice: concurrent callers join the
		// request already in flight rather than racing a start against a stop.
		if (this.inFlight) {
			return this.inFlight
		}
		this.enabled = enabled
		setRemoteControlEnabledGlobally(enabled)
		this.inFlight = (enabled ? this.start() : this.stop()).finally(() => {
			this.inFlight = undefined
		})
		return this.inFlight
	}

	private async start(): Promise<RemoteControlStatus> {
		if (this.server) {
			this.state = "connected"
			this.error = ""
			return this.status()
		}
		this.state = "connecting"
		try {
			// Dynamic import is intentional: `@cline/core/hub` pulls in the hub's prebuilt bundle, and
			// loading it here keeps that work — and the transport it sets up — confined to the moment
			// remote control is actually wanted, the same way the optional Claude Code provider is
			// lazy-loaded (see `sdk/packages/llms/src/providers/vendors/community.ts`).
			const { createLocalHubScheduleRuntimeHandlers, ensureHubServer } = await import("@cline/core")
			const ensure = () =>
				ensureHubServer({
					host: REMOTE_CONTROL_HOST,
					runtimeHandlers: createLocalHubScheduleRuntimeHandlers(),
				})
			const ensured = await this.waitForHubLock(ensure)
			if (!ensured) {
				// Turned off, or disposed, while waiting.
				this.state = "disconnected"
				this.error = ""
				return this.status()
			}
			if (!this.enabled && ensured.server) {
				// Turned off as the lock came free: the Hub just started is closed again.
				await ensured.server.close().catch(() => {})
				this.state = "disconnected"
				this.error = ""
				return this.status()
			}
			this.server = ensured.server
			if (ensured.server) {
				this.state = "connected"
				this.error = ""
			} else {
				this.state = "failed"
				this.error = "The hub reported no running server."
			}
		} catch (error) {
			this.server = undefined
			this.state = "failed"
			this.error = error instanceof Error ? error.message : String(error)
			Logger.error(`Remote control hub failed to start: ${this.error}`)
		}
		if (this.state === "connected") {
			await this.startRelay()
		}
		return this.status()
	}

	/**
	 * Starts the Hub, waiting while another Hub still holds its lock, as it can after an update is
	 * installed; that Hub lets go when its process exits. Shows Connecting with a waiting
	 * line meanwhile. Past the wait the holder is named as another window. Answers undefined when the
	 * wait was ended by Off or dispose. Any other failure is thrown at once.
	 */
	private async waitForHubLock<T>(ensure: () => Promise<T>): Promise<T | undefined> {
		const deadline = Date.now() + this.lockWaitMs
		this.waitingForLock = true
		try {
			for (;;) {
				try {
					return await ensure()
				} catch (error) {
					if (!isHubLockHeld(error)) {
						throw error
					}
					if (Date.now() >= deadline) {
						Logger.error(
							`Remote control could not start its Hub: ${error instanceof Error ? error.message : String(error)}`,
						)
						throw new Error(HUB_LOCK_ELSEWHERE)
					}
					if (this.error !== HUB_LOCK_WAITING) {
						Logger.warn(`Remote control is waiting for another Hub to release its lock: ${(error as Error).message}`)
						this.state = "connecting"
						this.error = HUB_LOCK_WAITING
						this.emit()
					}
				}
				await new Promise((resolve) => setTimeout(resolve, this.lockRetryMs))
				if (!this.waitingForLock || !this.enabled) {
					return undefined
				}
			}
		} finally {
			this.waitingForLock = false
		}
	}

	private async stop(): Promise<RemoteControlStatus> {
		const server = this.server
		this.server = undefined
		if (server) {
			try {
				await server.close()
			} catch (error) {
				Logger.error(`Remote control hub failed to close: ${String(error)}`)
			}
		}
		this.stopRelay()
		this.state = "disconnected"
		this.error = ""
		return this.status()
	}

	/**
	 * Open the outbound link to the relay the user configured. Absent settings mean no link at all —
	 * the mode still runs its local hub, and the popover says nothing about a relay rather than
	 * implying one that is missing.
	 */
	private async startRelay(): Promise<void> {
		const settings = readRelaySettingsGlobally()
		if (!settings.url || !settings.key) {
			this.relay = undefined
			this.relayStatus = undefined
			return
		}
		const { error } = validateRelayUrl(settings.url)
		if (error) {
			this.relayStatus = {
				state: "failed",
				host: settings.url,
				error,
				lastAttemptAt: Date.now(),
				consecutiveFailures: 0,
				nextPollInMs: settings.pollIntervalMs,
			}
			this.emit()
			return
		}
		const link = new RelayLink({
			url: settings.url,
			key: settings.key,
			extensionVersion: ExtensionRegistryInfo.version,
			pollIntervalMs: settings.pollIntervalMs,
			onChatEvent: (chatId, event) => this.queueInbound(chatId, event),
			onChatGap: (chatId) => this.sent.delete(chatId),
			onStatus: (status) => {
				this.relayStatus = status
				this.emit()
			},
		})
		this.relay = link
		await link.setSharedChats(await this.sharedChatList())
		await link.start()
		this.startPump()
		this.relayDataDir = await link.dataLocation().catch(() => "")
		this.emit()
	}

	private stopRelay(): void {
		this.stopPump()
		this.relay?.stop()
		this.relay = undefined
		this.relayStatus = undefined
	}

	/** The shared chats with their current names, for the relay's list. */
	private async sharedChatList(): Promise<{ id: string; name: string }[]> {
		const list: { id: string; name: string }[] = []
		for (const chatId of readRemoteSharedChatsGlobally()) {
			const view = await this.chatAccess?.view(chatId).catch(() => undefined)
			list.push({ id: chatId, name: view?.title || "Untitled chat" })
		}
		return list
	}

	/** Share one chat with paired devices, or stop sharing it. Stored machine-wide. */
	async setChatShared(chatId: string, shared: boolean): Promise<RemoteControlStatus> {
		setRemoteChatSharedGlobally(chatId, shared)
		if (!shared) {
			this.sent.delete(chatId)
		}
		await this.relay?.setSharedChats(await this.sharedChatList())
		this.emit()
		return this.status()
	}

	private requireRelay(): RelayLink {
		if (!this.relay || this.relayStatus?.state !== "connected") {
			throw new Error("The relay is not connected. Turn remote control on, and check the relay settings.")
		}
		return this.relay
	}

	async createPairingCode(): Promise<{ code: string; expiresInSeconds: number; pageUrl: string }> {
		const relay = this.requireRelay()
		const created = await relay.createPairingCode()
		return { ...created, pageUrl: relay.pageUrl() }
	}

	async listDevices(): Promise<RelayDevice[]> {
		return this.requireRelay().listDevices()
	}

	async removeDevice(deviceId: string): Promise<RelayDevice[]> {
		const relay = this.requireRelay()
		await relay.removeDevice(deviceId)
		return relay.listDevices()
	}

	private startPump(): void {
		this.stopPump()
		this.pumpTimer = setInterval(() => void this.pump(), CHAT_PUMP_INTERVAL_MS)
		this.pumpTimer.unref?.()
	}

	private stopPump(): void {
		if (this.pumpTimer) {
			clearInterval(this.pumpTimer)
			this.pumpTimer = undefined
		}
		this.sent.clear()
	}

	private pumping = false
	/**
	 * A page's events, handled one at a time in the order they arrived. Handled side by side, rapid
	 * Auto-approve flips each wrote back settings read before the others landed and undid them, and
	 * two messages could reach the chat in either order. Nothing queued waits on a model's turn: a
	 * message is handed to the chat without awaiting the reply.
	 */
	private inbound: Promise<void> = Promise.resolve()

	/**
	 * Sends each shared chat's new or changed messages, and any change in whether the model is working
	 * or in the chat's name. A chat nobody has opened on a page yet sends nothing until a page asks.
	 */
	private async pump(): Promise<void> {
		const relay = this.relay
		if (this.pumping || !relay || this.relayStatus?.state !== "connected" || !this.chatAccess) {
			return
		}
		this.pumping = true
		try {
			const autoApprove = this.sent.size ? await this.chatAccess.getAutoApprove().catch(() => undefined) : undefined
			const autoKey = JSON.stringify(autoApprove ?? {})
			for (const [chatId, last] of this.sent) {
				const view = await this.chatAccess.view(chatId).catch(() => undefined)
				if (!view) {
					continue
				}
				const events: RelayEvent[] = []
				const page = await this.forPage(view.messages)
				const remote = page.messages.map(toRemoteMessage).slice(-SNAPSHOT_MESSAGE_LIMIT)
				const changed: RemoteMessage[] = []
				const nextSignatures = new Map<number, string>()
				for (const message of remote) {
					const sig = signature(message)
					nextSignatures.set(message.ts, sig)
					if (last.signatures.get(message.ts) !== sig) {
						changed.push(message)
					}
				}
				// A message's ts is an id that is minted again when a chat's history is rendered again, so
				// the page orders by this list and drops anything not in it, rather than merging by ts.
				const order = remote.map((message) => message.ts)
				const orderKey = order.join(",")
				const meta = await this.meta(view, page.suggestion)
				const metaKey = JSON.stringify(meta)
				const updateDue =
					changed.length > 0 ||
					view.working !== last.working ||
					orderKey !== last.orderKey ||
					autoKey !== last.autoKey ||
					metaKey !== last.metaKey
				if (updateDue) {
					events.push({
						kind: "update",
						payload: { messages: changed, order, working: view.working, autoApprove, meta },
						sentAt: Date.now(),
					})
				}
				const titleDue = view.title !== last.title
				if (titleDue) {
					events.push({ kind: "title", payload: { title: view.title, workspace: view.workspace }, sentAt: Date.now() })
				}
				if (events.length === 0) {
					continue
				}
				// Recorded as sent only once the relay has accepted it: a failed post leaves everything
				// pending, and the next check sends it again.
				if (await relay.post(chatId, events)) {
					for (const [ts, sig] of nextSignatures) {
						last.signatures.set(ts, sig)
					}
					last.working = view.working
					last.orderKey = orderKey
					last.autoKey = autoKey
					last.metaKey = metaKey
					last.title = view.title
				}
			}
		} finally {
			this.pumping = false
		}
	}

	/** A page opened the chat: send it whole (its most recent messages), then only changes from here. */
	private async sendSnapshot(chatId: string): Promise<void> {
		const view = await this.chatAccess?.view(chatId).catch(() => undefined)
		if (!view || !this.relay) {
			return
		}
		const page = await this.forPage(view.messages)
		const messages = page.messages.map(toRemoteMessage).slice(-SNAPSHOT_MESSAGE_LIMIT)
		const autoApprove = await this.chatAccess?.getAutoApprove().catch(() => undefined)
		const meta = await this.meta(view, page.suggestion)
		this.sent.set(chatId, {
			signatures: new Map(messages.map((message) => [message.ts, signature(message)])),
			working: view.working,
			title: view.title,
			orderKey: messages.map((message) => message.ts).join(","),
			autoKey: JSON.stringify(autoApprove ?? {}),
			metaKey: JSON.stringify(meta),
		})
		await this.relay.post(chatId, [
			{
				kind: "snapshot",
				payload: {
					messages,
					working: view.working,
					autoApprove,
					title: view.title,
					workspace: view.workspace,
					meta,
				},
				sentAt: Date.now(),
			},
		])
	}

	private queueInbound(chatId: string, event: RelayEvent): void {
		this.inbound = this.inbound
			.then(() => this.handleInbound(chatId, event))
			.catch((error) => {
				Logger.error(`Remote control could not apply a ${event.kind} event to chat ${chatId}: ${String(error)}`)
			})
	}

	private async handleInbound(chatId: string, event: RelayEvent): Promise<void> {
		if (!readRemoteSharedChatsGlobally().includes(chatId) || !this.chatAccess) {
			return
		}
		const payload = (event.payload ?? {}) as {
			text?: unknown
			ts?: unknown
			approve?: unknown
			name?: unknown
			action?: unknown
			enabled?: unknown
		}
		try {
			if (event.kind === "sync") {
				await this.sendSnapshot(chatId)
			} else if (event.kind === "message" && typeof payload.text === "string" && payload.text.trim()) {
				await this.chatAccess.send(chatId, payload.text)
			} else if (event.kind === "decision" && typeof payload.ts === "number") {
				// Applied only while that exact request is still the one waiting, so a late tap on a page
				// cannot approve the request that came after it.
				Logger.debug(
					`Remote control received a ${payload.approve === true ? "Approve" : "Deny"} for chat ${chatId}, message ${payload.ts}`,
				)
				// The hidden suggested reply is not a message the page shows, so it is not the one waiting.
				const view = await this.chatAccess.view(chatId)
				const last = view ? splitConsentSuggestion(view.messages).messages.at(-1) : undefined
				if (last && last.ts === payload.ts && last.type === "ask" && !last.partial) {
					Logger.debug(`Remote control is applying the decision to chat ${chatId}, message ${payload.ts} (${last.ask})`)
					await this.chatAccess.decide(chatId, payload.ts, payload.approve === true)
				} else {
					const waiting = last
						? `message ${last.ts} (${last.type}${last.ask ? ` ${last.ask}` : ""}${last.say ? ` ${last.say}` : ""}${last.partial ? ", partial" : ""})`
						: "no message"
					Logger.warn(
						`Remote control refused a ${payload.approve === true ? "Approve" : "Deny"} for chat ${chatId}: the page sent message ${payload.ts}, and the chat's last is ${waiting}`,
					)
				}
			} else if (
				event.kind === "autoApprove" &&
				typeof payload.action === "string" &&
				typeof payload.enabled === "boolean"
			) {
				await this.chatAccess.setAutoApprove(payload.action, payload.enabled)
			} else if (event.kind === "compact") {
				const notice = await this.chatAccess.compact(chatId)
				if (notice) {
					await this.relay?.post(chatId, [{ kind: "notice", payload: { text: notice }, sentAt: Date.now() }])
				}
			} else if (event.kind === "stopSharing") {
				await this.setChatShared(chatId, false)
				return
			} else if (event.kind === "rename" && typeof payload.name === "string") {
				await this.chatAccess.rename(chatId, payload.name)
				await this.relay?.setSharedChats(await this.sharedChatList())
			}
			// The page is waiting on this: its answer goes out now rather than on the next half-second check.
			if (event.kind !== "sync") {
				await this.pump()
			}
		} catch (error) {
			Logger.error(`Remote control could not apply a ${event.kind} event to chat ${chatId}: ${String(error)}`)
		}
	}

	/** Re-open the link after the relay settings change, without disturbing the local hub. */
	async applyRelaySettings(): Promise<RemoteControlStatus> {
		this.stopRelay()
		if (this.enabled && this.state === "connected") {
			await this.startRelay()
		}
		return this.status()
	}

	/**
	 * Stops this process's transport without touching the stored choice. The mode comes back on the next
	 * activation because the choice persists and the process does not — that is what surviving a window
	 * reload means.
	 */
	async dispose(): Promise<void> {
		this.waitingForLock = false
		await this.stop()
	}
}

export const remoteControlManager = new RemoteControlManager()
