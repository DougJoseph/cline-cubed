import type { CoreSessionEvent } from "@cline/core"
import type { ClineApiReqInfo, ClineMessage } from "@shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import type { MessageIdMinter } from "./message-id-minter"
import type { TaskProxy } from "./task-proxy"
import { pushMessageToWebview } from "./webview-grpc-bridge"

export type SessionEventListener = (messages: ClineMessage[], event: CoreSessionEvent) => void

export interface SdkMessageCoordinatorOptions {
	/**
	 * Cline Cubed: resolve the TASK PROXY for a given session. `sessionId` is the session
	 * whose messages are flowing; undefined means the focused task. Each live session has its own
	 * proxy, so concurrent chats write into their own message state.
	 */
	getTask: (sessionId?: string) => TaskProxy | undefined
	/**
	 * The process-wide id/seq/epoch authority. When provided, every message flowing to the
	 * webview is stamped with a fresh `seq` and the current `epoch` so the webview can merge
	 * convergently and fence stale traffic. Optional for tests.
	 */
	getMinter?: () => MessageIdMinter
}

export class SdkMessageCoordinator {
	private readonly sessionEventListeners = new Set<SessionEventListener>()
	private saveClineMessagesTimer: ReturnType<typeof setTimeout> | undefined

	constructor(private readonly options: SdkMessageCoordinatorOptions) {}

	/**
	 * Stamp `seq` (freshness) and `epoch` (fence) on each message IN PLACE, synchronously,
	 * before it is stored or emitted. The same object references are added to the message state
	 * handler AND emitted through the partial stream, so both channels carry identical stamps.
	 * A message that is updated (partial → final, same id) passes through again and gets a NEW,
	 * higher `seq`, so the webview always keeps the freshest copy regardless of arrival order.
	 */
	private stamp(messages: ClineMessage[]): void {
		const minter = this.options.getMinter?.()
		if (!minter) {
			return
		}
		const epoch = minter.epoch
		for (const message of messages) {
			message.seq = minter.nextSeq()
			message.epoch = epoch
		}
	}

	dispose(): void {
		this.cancelPendingSave()
		this.sessionEventListeners.clear()
	}

	cancelPendingSave(): void {
		if (this.saveClineMessagesTimer) {
			clearTimeout(this.saveClineMessagesTimer)
			this.saveClineMessagesTimer = undefined
		}
	}

	onSessionEvent(listener: SessionEventListener): () => void {
		this.sessionEventListeners.add(listener)
		return () => {
			this.sessionEventListeners.delete(listener)
		}
	}

	emitSessionEvents(messages: ClineMessage[], event: CoreSessionEvent): void {
		for (const listener of this.sessionEventListeners) {
			try {
				listener(messages, event)
			} catch (error) {
				Logger.error("[SdkController] Error in session event listener:", error)
			}
		}
	}

	appendMessages(messages: ClineMessage[], sessionId?: string): void {
		// Stamp seq/epoch BEFORE storing/emitting so both the message-state handler and the
		// partial-message stream carry identical, freshness-ordered, epoch-fenced messages.
		this.stamp(messages)

		const task = this.options.getTask(sessionId)
		if (!task?.messageStateHandler) {
			return
		}

		task.messageStateHandler.addMessages(messages)
	}

	replaceMessages(messages: ClineMessage[], sessionId?: string): void {
		this.stamp(messages)

		const task = this.options.getTask(sessionId)
		if (!task?.messageStateHandler) {
			return
		}

		task.messageStateHandler.replaceMessages(messages)
	}

	appendAndEmit(messages: ClineMessage[], event: CoreSessionEvent): void {
		// V7: messages belong to the event's SESSION, not the focused task.
		this.appendMessages(messages, event.payload.sessionId)
		this.emitSessionEvents(messages, event)
	}

	emitHookMessage(message: ClineMessage, sessionId?: string): void {
		this.appendMessages([message], sessionId)
		// Stamped with its session so it reaches only the chat surface showing that session.
		pushMessageToWebview(message, sessionId).catch(() => {})
	}

	/**
	 * Finalize messages for saving to disk when a task is being cleared.
	 * - Strips `partial` flags so the UI doesn't show a streaming/cancel state
	 * - Updates the last `api_req_started` with a cancel reason if it has no cost
	 */
	finalizeMessagesForSave(messages: ClineMessage[]): ClineMessage[] {
		return messages.map((msg, index) => {
			const updated = { ...msg }

			if (updated.partial) {
				delete updated.partial
			}

			if (updated.type === "say" && updated.say === "api_req_started") {
				try {
					const info: ClineApiReqInfo = JSON.parse(updated.text || "{}")
					if (info.cost === undefined && info.cancelReason === undefined) {
						const isLast = !messages.slice(index + 1).some((m) => m.type === "say" && m.say === "api_req_started")
						if (isLast) {
							info.cancelReason = "user_cancelled"
							updated.text = JSON.stringify(info)
						}
					}
				} catch {
					// Ignore parse errors from legacy or malformed messages.
				}
			}

			return updated
		})
	}
}
