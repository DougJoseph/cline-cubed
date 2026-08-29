import { chatSurfaceForSession } from "@core/controller/chat-surfaces"
import type { ClineMessage, TurnPhase } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { Logger } from "@/shared/services/Logger"
import type { SdkInteractionCoordinator } from "./sdk-interaction-coordinator"
import type { SdkMessageCoordinator } from "./sdk-message-coordinator"
import { isAbortError, type SdkSessionLifecycle } from "./sdk-session-lifecycle"
import type { SdkTaskHistory } from "./sdk-task-history"
import { createTaskProxy, type TaskProxy } from "./task-proxy"

export interface SdkTaskControlCoordinatorOptions {
	sessions: SdkSessionLifecycle
	interactions: SdkInteractionCoordinator
	messages: SdkMessageCoordinator
	taskHistory: SdkTaskHistory
	getTask: () => TaskProxy | undefined
	setTask: (task: TaskProxy | undefined) => void
	/** Cline Cubed: `sessionId` names the conversation the response belongs to — never omitted
	 *  by the proxy this coordinator builds, or the response routes by focus instead. */
	onAskResponse: (text?: string, images?: string[], files?: string[], sessionId?: string) => Promise<void>
	resetMessageTranslator: () => void
	/** Cline Cubed: `sessionId` scopes the post to that chat; omitted = the focused one. */
	postStateToWebview: (sessionId?: string) => Promise<void>
	/**
	 * Drops the StateManager's task-scoped settings overlay (persisting pending
	 * writes first). Task settings — e.g. autoApprovalSettings written by
	 * toggling auto-approve while a task is open — shadow global settings in
	 * getGlobalSettingsKey(). If the overlay outlives the task view, later
	 * global updates are accepted but never surface in posted state (the stale
	 * overlay version wins), which froze the auto-approve checkboxes after
	 * "New Task" (#13260). Must run whenever the task view is cleared or
	 * switched to another task.
	 */
	clearTaskSettings: () => Promise<void>
	/**
	 * Sets the authoritative turn phase. showTaskWithId must derive the phase
	 * from the reopened conversation (resumable/completed) — leaving the
	 * previous task's phase in place hides the Resume button for interrupted
	 * sessions opened from History (and can leak stale buttons in general).
	 */
	setTurnPhase: (phase: TurnPhase, anchorTs?: number) => void
	/**
	 * Raise the cancel fence SYNCHRONOUSLY before aborting the SDK session: bump the epoch so any
	 * straggler events the SDK emits after the abort request carry the old epoch (and are dropped
	 * by the webview), and mark the active turn cancelled so the session-event coordinator
	 * suppresses its remaining DISPLAY output (usage is still accounted).
	 * Cline Cubed: `sessionId` scopes the translator-state clear to the CANCELLED session.
	 */
	raiseCancelFence?: (sessionId?: string) => void
}

export class SdkTaskControlCoordinator {
	/**
	 * Generation counter for task-view mutations (showTaskWithId / clearTask).
	 * showTaskWithId awaits several reads before installing the task proxy; a
	 * request that loses the race to a newer mutation abandons installation at
	 * the next fence check so the user's latest selection always wins.
	 */
	private taskViewGeneration = 0

	constructor(private readonly options: SdkTaskControlCoordinatorOptions) {}

	async cancelClineTaskOnSignOut(isClineManagedProvider: boolean): Promise<void> {
		const activeSession = this.options.sessions.getActiveSession()
		if (!isClineManagedProvider || !activeSession?.isRunning) {
			return
		}

		await this.cancelTask()
	}

	async cancelTask(targetSessionId?: string): Promise<void> {
		// Cline Cubed: cancel the NAMED chat's session — Cancel pressed in one chat must abort
		// that chat's turn, never whichever chat is active. No name = the focused session
		// (surface-less legacy callers).
		const targetSession = targetSessionId
			? this.options.sessions.getLiveSession(targetSessionId)
			: this.options.sessions.getActiveSession()
		if (!targetSession) {
			Logger.warn(
				targetSessionId
					? `[SdkController] cancelTask: Session ${targetSessionId} is not live; nothing to cancel`
					: "[SdkController] cancelTask: No active session",
			)
			return
		}

		const { sdkHost, sessionId } = targetSession
		// Cline Cubed: only the cancelled session's pendings — other chats' asks stay live.
		this.options.interactions.clearPending("Task cancelled", sessionId)

		// FENCE FIRST: raise the cancel fence synchronously BEFORE awaiting the abort. Any event
		// the SDK emits after this point carries the old epoch (dropped by the webview) and is
		// marked cancelled (display suppressed by the session-event coordinator; usage still
		// accounted). Order matters — aborting first would leave a window where a straggler gets
		// the new epoch. Scoped to the cancelled session's own translator state.
		this.options.raiseCancelFence?.(sessionId)

		try {
			await sdkHost.abort(sessionId)
		} catch (error) {
			if (!isAbortError(error)) {
				Logger.error("[SdkController] Failed to abort session:", error)
			} else {
				Logger.debug(`[SdkController] AbortError during cancelTask (expected): ${sessionId}`)
			}
		}

		this.options.sessions.setRunning(false, sessionId)

		const resumeMessage: ClineMessage = {
			ts: Date.now(),
			type: "ask",
			ask: "resume_task",
			text: "",
			partial: false,
		}
		this.options.messages.appendAndEmit([resumeMessage], { type: "status", payload: { sessionId, status: "cancelled" } })

		await this.options.postStateToWebview(sessionId)
		Logger.log(`[SdkController] Task cancelled: ${sessionId}`)
	}

	async clearTask(options: { stopActiveSession?: boolean } = {}): Promise<void> {
		// Supersede any in-flight showTaskWithId so it cannot re-install a task
		// after the user cleared the view (e.g. clicked New Task).
		this.taskViewGeneration++

		// Cline Cubed: a genuine user clear stops the focused SDK session; reinit of a
		// live session (focus-without-stop) must NOT stop any other session. Pendings are
		// cleared only for the session actually being stopped — a bookkeeping clear (task
		// switch) leaves the outgoing chat's pending ask live, because that chat is still
		// running and its question still awaits ITS answer.
		if (options.stopActiveSession !== false) {
			const endingSessionId = this.options.sessions.getActiveSession()?.sessionId
			if (endingSessionId) {
				this.options.interactions.clearPending("Task cleared", endingSessionId)
			}
			await this.options.sessions.endActiveSession("clearTask")
		}

		const task = this.options.getTask()
		if (task) {
			// SDK session persistence owns conversation history. Do not write classic
			// ui_messages.json here; history viewing reloads from SDK readMessages().
			this.options.messages.cancelPendingSave()
			// Cline Cubed: chats run side by side, and this clear is often just bookkeeping for a
			// task SWITCH. Wiping the outgoing task's messages would gut a chat that is still
			// alive or still on screen — so the transcript is dropped only when the session is
			// neither live nor shown by any surface.
			if (chatSurfaceForSession(task.taskId) === undefined && !this.options.sessions.getLiveSession(task.taskId)) {
				task.messageStateHandler.clear()
			}
			this.options.setTask(undefined)
		}

		await this.options.clearTaskSettings()

		this.options.resetMessageTranslator()
	}

	/**
	 * Opens a task from History. The view generation is allocated synchronously
	 * on entry — BEFORE any asynchronous work, including the history lookup —
	 * so the newest user selection always holds the newest generation and every
	 * older in-flight request self-abandons at its next fence check. (The
	 * lookup used to live in SdkController before the generation was taken; a
	 * stalled preflight could then re-enter with a NEWER generation than a
	 * later selection and replace it.)
	 *
	 * Returns the task's HistoryItem, or undefined when the task is unknown.
	 * A superseded call still returns the item (the lookup succeeded); it just
	 * skips mutating the task view.
	 */
	async showTaskWithId(taskId: string): Promise<HistoryItem | undefined> {
		const generation = ++this.taskViewGeneration
		const isSuperseded = (): boolean => {
			if (generation === this.taskViewGeneration) {
				return false
			}
			Logger.debug(`[SdkController] showTaskWithId superseded by a newer selection; skipping: ${taskId}`)
			return true
		}

		let historyItem: HistoryItem | undefined
		try {
			historyItem = await this.options.taskHistory.findHistoryItem(taskId)
		} catch (error) {
			Logger.error(`[SdkController] Failed to look up task in history: ${taskId}`, error)
			return undefined
		}
		if (!historyItem) {
			Logger.error(`[SdkController] Task not found in history: ${taskId}`)
			return undefined
		}

		// FENCE: before stopping the active session. A superseded request must
		// not stop a session that a newer selection just started or resumed.
		if (isSuperseded()) {
			return historyItem
		}

		try {
			// When reopening the task that is currently active, wait for its stop to
			// land so the persisted session status read below reflects how the last
			// turn actually ended (completed vs cancelled) instead of a transient
			// non-terminal status.
			// Cline Cubed: a live session is focused in place — never stopped — so opening or
			// revisiting one chat leaves every other chat streaming. Only a session that is not
			// live is torn down here, and only when it is the one being reopened — and ONLY that
			// session's pending ask/approval is discarded with it. Opening a chat used to clear
			// EVERY chat's pendings ("Task switched"), which silently answered another chat's
			// question with an empty string; under concurrency, opening one chat says nothing
			// about the others.
			const liveTarget = this.options.sessions.getLiveSession(taskId)
			if (!liveTarget) {
				const activeSession = this.options.sessions.getActiveSession()
				if (activeSession?.sessionId === taskId) {
					this.options.interactions.clearPending("Task switched", taskId)
					await this.options.sessions.endActiveSession("showTaskWithId", { awaitStop: true })
				}
			}

			// FENCE: everything below mutates the shared task view (clearing the
			// current task, installing the new proxy, setting the turn phase). If a
			// newer showTaskWithId/clearTask started while this call awaited I/O,
			// bail out so the stale request cannot clobber the newer selection.
			if (isSuperseded()) {
				return historyItem
			}

			const currentTask = this.options.getTask()
			// Cline Cubed: opening a chat here must not blank a DIFFERENT chat. The outgoing
			// task's transcript is dropped only when its session is neither live nor shown by
			// any surface.
			if (
				currentTask &&
				chatSurfaceForSession(currentTask.taskId) === undefined &&
				!this.options.sessions.getLiveSession(currentTask.taskId)
			) {
				currentTask.messageStateHandler.clear()
			}

			// The outgoing task's settings overlay must not apply to the newly
			// opened task (see clearTaskSettings option doc).
			await this.options.clearTaskSettings()

			this.options.resetMessageTranslator()

			// Load messages before installing the new task proxy so any concurrent
			// postStateToWebview() caller never sees the new id with empty messages.
			const isLegacyTask = await this.options.taskHistory.isLegacyTask(taskId)
			const sessionStatus = isLegacyTask ? undefined : await this.options.taskHistory.getSessionStatus(taskId)
			const rawMessages = await this.options.taskHistory.getClineMessages(taskId)
			if (isSuperseded()) {
				return historyItem
			}
			const messages = this.options.messages.finalizeMessagesForSave(rawMessages)
			const cleanedMessages = isLegacyTask
				? this.appendLegacyTaskWarningAndResumeMessage(messages)
				: messages.length > 0
					? this.appendFreshResumeMessage(messages, sessionStatus)
					: []

			const task = createTaskProxy(
				taskId,
				// Cline Cubed: forward the proxy's session id (4th argument). Without it a message
				// typed into a history-opened chat routes session-blind, and the focused-chat
				// fallbacks decide where it lands.
				(text?: string, images?: string[], files?: string[], proxySessionId?: string) =>
					this.options.onAskResponse(text, images, files, proxySessionId ?? taskId),
				(proxySessionId?: string) => this.cancelTask(proxySessionId ?? taskId),
			)
			if (cleanedMessages.length > 0) {
				task.messageStateHandler.addMessages(cleanedMessages)
			}
			this.options.setTask(task)

			// Derive the turn phase from the appended resume ask. The webview
			// renders footer buttons from the authoritative TurnState, so without
			// this the phase left over from the previous context (often "idle")
			// hides the Resume button for interrupted/failed sessions.
			const lastMessage = cleanedMessages.at(-1)
			if (lastMessage?.type === "ask" && lastMessage.ask === "resume_completed_task") {
				this.options.setTurnPhase("completed", lastMessage.ts)
			} else if (lastMessage?.type === "ask" && lastMessage.ask === "resume_task") {
				this.options.setTurnPhase("resumable", lastMessage.ts)
			} else {
				this.options.setTurnPhase("idle")
			}

			if (cleanedMessages.length > 0) {
				Logger.log(`[SdkController] Loaded ${cleanedMessages.length} messages for task: ${taskId}`)
			} else {
				Logger.log(`[SdkController] No messages found for task: ${taskId}`)
			}

			// The final state update below includes the loaded clineMessages. Avoid pushing
			// each historical message through the partial-message stream one-by-one; for
			// long tasks that serial loop can dominate history-open latency.
			await this.options.postStateToWebview()
			Logger.log(`[SdkController] Showing task: ${taskId}`)
		} catch (error) {
			Logger.error("[SdkController] Failed to show task:", error)
		}
		return historyItem
	}

	private appendFreshResumeMessage(messages: ClineMessage[], sessionStatus?: string): ClineMessage[] {
		// The persisted session status is the only reliable completion signal:
		// SDK conversations do not record a completion tool call in the
		// transcript (a completed turn and a turn interrupted mid-stream both
		// end with plain assistant text), and history rendering appends a
		// synthetic trailing ask:"completion_result" either way, so the message
		// tail cannot be used. When the status is unknown (e.g. a transient
		// read failure), default to the Resume affordance: resuming a completed
		// task is harmless, while hiding Resume on an interrupted one is the
		// data-loss illusion this exists to prevent.
		const resumeAsk = sessionStatus === "completed" ? "resume_completed_task" : "resume_task"
		const cleanedMessages = messages.filter((m) => m.ask !== "resume_task" && m.ask !== "resume_completed_task")
		cleanedMessages.push({
			ts: Date.now(),
			type: "ask",
			ask: resumeAsk,
			text: "",
		})
		return cleanedMessages
	}

	private appendLegacyTaskWarningAndResumeMessage(messages: ClineMessage[]): ClineMessage[] {
		const cleanedMessages = messages.filter((m) => m.ask !== "resume_task" && m.ask !== "resume_completed_task")
		const now = Date.now()
		cleanedMessages.push(
			{
				ts: now,
				type: "say",
				say: "text",
				text: "⚠️ This is a legacy task. It may not work as well because tool names may have changed.",
			},
			{
				ts: now + 1,
				type: "ask",
				ask: "resume_task",
				text: "",
			},
		)
		return cleanedMessages
	}
}
