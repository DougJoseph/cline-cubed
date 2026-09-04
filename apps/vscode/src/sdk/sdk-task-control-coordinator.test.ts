import type { ClineMessage } from "@shared/ExtensionMessage"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SdkInteractionCoordinator } from "./sdk-interaction-coordinator"
import { SdkMessageCoordinator } from "./sdk-message-coordinator"
import { SdkTaskControlCoordinator, type SdkTaskControlCoordinatorOptions } from "./sdk-task-control-coordinator"
import { createTaskProxy } from "./task-proxy"

vi.mock("@/shared/services/Logger", () => ({
	Logger: {
		debug: vi.fn(),
		error: vi.fn(),
		log: vi.fn(),
		warn: vi.fn(),
	},
}))

describe("SdkTaskControlCoordinator", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("cancels the active session and emits a resume task ask", async () => {
		const activeSession = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession })

		await coordinator.cancelTask()

		expect(options.interactions.clearPending).toHaveBeenCalledWith("Task cancelled", "session-123")
		expect(activeSession.sdkHost.abort).toHaveBeenCalledWith("session-123")
		expect(options.sessions.setRunning).toHaveBeenCalledWith(false, "session-123")
		expect(options.messages.appendAndEmit).toHaveBeenCalledWith(
			[expect.objectContaining({ type: "ask", ask: "resume_task" })],
			{ type: "status", payload: { sessionId: "session-123", status: "cancelled" } },
		)
		expect(options.postStateToWebview).toHaveBeenCalledOnce()
	})

	it("cancels a NAMED background session — never the active one", async () => {
		// Cancel pressed in a background chat's UI names that chat's session; the ACTIVE
		// session (a different chat, mid-stream) must be left completely alone.
		const activeSession = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession })
		const backgroundSession = {
			sessionId: "background-task",
			sdkHost: { abort: vi.fn().mockResolvedValue(undefined) },
			isRunning: true,
		}
		options.sessions.getLiveSession.mockImplementation((sessionId: string) =>
			sessionId === "background-task" ? backgroundSession : undefined,
		)

		await coordinator.cancelTask("background-task")

		expect(backgroundSession.sdkHost.abort).toHaveBeenCalledWith("background-task")
		expect(activeSession.sdkHost.abort).not.toHaveBeenCalled()
		expect(options.interactions.clearPending).toHaveBeenCalledWith("Task cancelled", "background-task")
		expect(options.sessions.setRunning).toHaveBeenCalledWith(false, "background-task")
		expect(options.messages.appendAndEmit).toHaveBeenCalledWith(
			[expect.objectContaining({ type: "ask", ask: "resume_task" })],
			{ type: "status", payload: { sessionId: "background-task", status: "cancelled" } },
		)
	})

	it("cancelling a NAMED session that is not live cancels NOTHING (no active-session fallback)", async () => {
		const activeSession = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession })

		await coordinator.cancelTask("gone-task")

		expect(activeSession.sdkHost.abort).not.toHaveBeenCalled()
		expect(options.interactions.clearPending).not.toHaveBeenCalled()
	})

	it("cancels a running Cline task when the user signs out", async () => {
		const activeSession = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession })

		await coordinator.cancelClineTaskOnSignOut(true)

		expect(activeSession.sdkHost.abort).toHaveBeenCalledWith("session-123")
		expect(options.sessions.setRunning).toHaveBeenCalledWith(false, "session-123")
	})

	it("does not cancel a non-Cline task when the user signs out", async () => {
		const activeSession = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession })

		await coordinator.cancelClineTaskOnSignOut(false)

		expect(activeSession.sdkHost.abort).not.toHaveBeenCalled()
		expect(options.sessions.setRunning).not.toHaveBeenCalled()
	})

	it("raises the cancel fence BEFORE aborting the session (so stragglers are fenced)", async () => {
		const activeSession = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession })

		const order: string[] = []
		;(options.raiseCancelFence as ReturnType<typeof vi.fn>).mockImplementation(() => order.push("fence"))
		;(activeSession.sdkHost.abort as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			order.push("abort")
		})

		await coordinator.cancelTask()

		expect(options.raiseCancelFence).toHaveBeenCalledOnce()
		expect(order).toEqual(["fence", "abort"])
	})

	it("clears the active session and task proxy without writing classic UI message persistence", async () => {
		const activeSession = makeActiveSession()
		const task = makeTask("task-1", [{ ts: 1, type: "say", say: "text", text: "hi", partial: true }])
		const { coordinator, options, state } = makeCoordinator({ activeSession, task })

		await coordinator.clearTask({ endSessionId: "session-123" })

		expect(options.interactions.clearPending).toHaveBeenCalledWith("Task cleared", "session-123")
		expect(options.sessions.endSession).toHaveBeenCalledWith("clearTask", { sessionId: "session-123" })
		expect(options.messages.finalizeMessagesForSave).not.toHaveBeenCalled()
		expect(options.messages.cancelPendingSave).toHaveBeenCalledOnce()
		expect(task.messageStateHandler.clear).toHaveBeenCalledOnce()
		expect(state.task).toBeUndefined()
		expect(options.resetMessageTranslator).toHaveBeenCalledOnce()
	})

	it("drops the task-scoped settings overlay when the task is cleared (#13260)", async () => {
		// autoApprovalSettings written via setTaskSettings while a task is open
		// shadow global settings in getGlobalSettingsKey(). If the overlay
		// survives "New Task", later global updates are accepted but never
		// reach the webview (the stale overlay version wins), freezing the
		// auto-approve checkboxes.
		const { coordinator, options } = makeCoordinator({
			activeSession: makeActiveSession(),
			task: makeTask("task-1"),
		})

		await coordinator.clearTask()

		expect(options.clearTaskSettings).toHaveBeenCalledOnce()
	})

	it("drops the outgoing task's settings overlay when switching to another task", async () => {
		const { coordinator, options } = makeCoordinator({
			activeSession: makeActiveSession(),
			task: makeTask("old-task"),
			hasHistoryItem: true,
			clineMessages: [{ ts: 1, type: "say", say: "task", text: "hello" }],
			sessionStatus: "completed",
		})

		await coordinator.showTaskWithId("task-1")

		expect(options.clearTaskSettings).toHaveBeenCalledOnce()
		// The overlay must be gone before the new proxy is installed.
		expect(options.clearTaskSettings.mock.invocationCallOrder[0]).toBeLessThan(options.setTask.mock.invocationCallOrder[0])
	})

	it("shows a task by creating a proxy, loading messages, and appending a fresh resume ask", async () => {
		const existingTask = makeTask("old-task")
		const activeSession = makeActiveSession()
		const sdkClineMessages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "hello" },
			{ ts: 2, type: "ask", ask: "completion_result", text: "" },
		]
		const { coordinator, options, state } = makeCoordinator({
			activeSession,
			task: existingTask,
			hasHistoryItem: true,
			clineMessages: sdkClineMessages,
			sessionStatus: "completed",
		})

		await coordinator.showTaskWithId("task-1")

		expect(options.taskHistory.findHistoryItem).toHaveBeenCalledWith("task-1")
		// Cline Cubed: the running session belongs to a DIFFERENT chat, and chats coexist — so
		// opening this one must leave that one alone. This assertion used to be the opposite
		// (`endSession` called), which was the single-chat behaviour: opening any task tore
		// down whatever was running. See the two tests below for the cases that DO tear down.
		expect(options.sessions.endSession).not.toHaveBeenCalled()
		expect(existingTask.messageStateHandler.clear).toHaveBeenCalledOnce()
		expect(options.resetMessageTranslator).toHaveBeenCalledOnce()
		expect(state.task?.taskId).toBe("task-1")
		expect(options.taskHistory.getClineMessages).toHaveBeenCalledWith("task-1")
		expect(state.task?.messageStateHandler.getClineMessages()).toEqual([
			{ ts: 1, type: "say", say: "task", text: "hello" },
			{ ts: 2, type: "ask", ask: "completion_result", text: "" },
			expect.objectContaining({ type: "ask", ask: "resume_completed_task" }),
		])
		expect(options.postStateToWebview).toHaveBeenCalledOnce()
	})

	it("tears down the session being reopened when it is active but NO LONGER live", async () => {
		// The one teardown that survives concurrency: the chat being reopened is the active one and
		// its session is dead, so it is stopped and rebuilt from history. `awaitStop: true` matters
		// — the persisted session status is read next, and it must reflect how the last turn really
		// ended rather than a transient non-terminal status.
		const { coordinator, options } = makeCoordinator({
			activeSession: makeActiveSession(),
			hasHistoryItem: true,
			sessionStatus: "completed",
		})

		await coordinator.showTaskWithId("session-123")

		expect(options.sessions.endSession).toHaveBeenCalledWith("showTaskWithId", { awaitStop: true, sessionId: "session-123" })
	})

	it("focuses a LIVE session in place instead of stopping it", async () => {
		// Revisiting a chat that is mid-stream must never interrupt it.
		const { coordinator, options } = makeCoordinator({
			activeSession: makeActiveSession(),
			hasHistoryItem: true,
			liveSessionIds: ["session-123"],
			sessionStatus: "completed",
		})

		await coordinator.showTaskWithId("session-123")

		expect(options.sessions.endSession).not.toHaveBeenCalled()
	})

	it("does NOT wipe the outgoing chat's transcript while its session is still live", async () => {
		// A task switch is bookkeeping. Wiping the outgoing chat's messages would gut a chat that
		// is still streaming — the defect that made two open chats blank each other.
		const existingTask = makeTask("old-task")
		const { coordinator } = makeCoordinator({
			activeSession: makeActiveSession(),
			task: existingTask,
			hasHistoryItem: true,
			liveSessionIds: ["old-task"],
			sessionStatus: "completed",
		})

		await coordinator.showTaskWithId("task-1")

		expect(existingTask.messageStateHandler.clear).not.toHaveBeenCalled()
	})

	it("leaves ANOTHER chat's pending approval untouched when opening a different task", async () => {
		// Cline Cubed: chats run side by side — opening one chat says nothing about the others.
		// The old contract settled EVERY pending on any task switch ("Task switched"), which
		// silently denied a still-streaming chat's approval; the pending must instead stay
		// resolvable by ITS OWN session and only its own.
		const pendingTask = createTaskProxy("old-task", vi.fn(), vi.fn())
		const interactions = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => pendingTask }),
			getSessionId: () => pendingTask.taskId,
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})
		const { options } = makeCoordinator({
			activeSession: makeActiveSession(),
			hasHistoryItem: true,
			clineMessages: [],
		})
		const coordinator = new SdkTaskControlCoordinator({ ...options, interactions })
		const approvalPromise = interactions.handleRequestToolApproval({
			agentId: "agent",
			conversationId: "old-task",
			iteration: 1,
			toolCallId: "tool-call",
			toolName: "read_files",
			input: {},
			policy: { autoApprove: false },
		})
		await vi.waitFor(() => expect(pendingTask.messageStateHandler.getClineMessages()).toHaveLength(1))

		await coordinator.showTaskWithId("new-task")

		// Still pending: a response from a DIFFERENT session resolves nothing…
		expect(interactions.resolvePendingToolApproval("new-task", undefined, "yesButtonClicked")).toBe(false)
		// …and the asking session's own response still lands.
		expect(interactions.resolvePendingToolApproval("old-task", undefined, "yesButtonClicked")).toBe(true)
		await expect(approvalPromise).resolves.toEqual({ approved: true })
	})

	it("leaves ANOTHER chat's pending question untouched when opening a different task", async () => {
		const pendingTask = createTaskProxy("old-task", vi.fn(), vi.fn())
		const interactions = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => pendingTask }),
			getSessionId: () => pendingTask.taskId,
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})
		const { options } = makeCoordinator({
			activeSession: makeActiveSession(),
			hasHistoryItem: true,
			clineMessages: [],
		})
		const coordinator = new SdkTaskControlCoordinator({ ...options, interactions })
		const questionPromise = interactions.handleAskQuestion("Which option?", ["A", "B"], { sessionId: "old-task" })
		await vi.waitFor(() => expect(pendingTask.messageStateHandler.getClineMessages()).toHaveLength(1))

		await coordinator.showTaskWithId("new-task")

		expect(interactions.resolvePendingAskQuestion("new-task", "late answer")).toBe(false)
		expect(interactions.resolvePendingAskQuestion("old-task", "the real answer")).toBe(true)
		await expect(questionPromise).resolves.toBe("the real answer")
	})

	it("settles the reopened session's OWN pending when tearing it down (same-task reopen)", async () => {
		// The one legitimate settle on a task open: reopening the non-live ACTIVE session tears
		// it down first, and the torn-down session's pending must unwind — scoped to that
		// session alone.
		const pendingTask = createTaskProxy("session-123", vi.fn(), vi.fn())
		const interactions = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => pendingTask }),
			getSessionId: () => pendingTask.taskId,
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})
		const { options } = makeCoordinator({
			activeSession: makeActiveSession(),
			hasHistoryItem: true,
			clineMessages: [],
		})
		const coordinator = new SdkTaskControlCoordinator({ ...options, interactions })
		const approvalPromise = interactions.handleRequestToolApproval({
			agentId: "agent",
			conversationId: "session-123",
			iteration: 1,
			toolCallId: "tool-call",
			toolName: "read_files",
			input: {},
			policy: { autoApprove: false },
		})
		await vi.waitFor(() => expect(pendingTask.messageStateHandler.getClineMessages()).toHaveLength(1))

		await coordinator.showTaskWithId("session-123")

		await expect(approvalPromise).resolves.toEqual({ approved: false, reason: "Task switched" })
		expect(interactions.resolvePendingToolApproval("session-123", undefined, "yesButtonClicked")).toBe(false)
	})

	it("forwards the session id on responses from a history-opened chat's proxy", async () => {
		// The proxy must forward its 4th callback argument: without it a message typed into a
		// history-opened chat routes with NO session, and lands in the focused chat instead.
		const { coordinator, options, state } = makeCoordinator({
			hasHistoryItem: true,
			clineMessages: [{ ts: 1, type: "say", say: "task", text: "hello" }],
			sessionStatus: "completed",
		})

		await coordinator.showTaskWithId("task-1")
		const proxy = state.task as unknown as ReturnType<typeof createTaskProxy>
		await proxy.handleWebviewAskResponse("messageResponse", "hi again", ["img.png"], ["file.ts"])

		expect(options.onAskResponse).toHaveBeenCalledWith("hi again", ["img.png"], ["file.ts"], "task-1")
	})

	it("shows a legacy task with a warning and a resume ask", async () => {
		const legacyMessages: ClineMessage[] = [{ ts: 1, type: "say", say: "task", text: "legacy task" }]
		const { coordinator, options, state } = makeCoordinator({
			hasHistoryItem: true,
			clineMessages: legacyMessages,
			isLegacyTask: true,
		})

		await coordinator.showTaskWithId("legacy-task")

		expect(options.taskHistory.isLegacyTask).toHaveBeenCalledWith("legacy-task")
		expect(state.task?.messageStateHandler.getClineMessages()).toEqual([
			{ ts: 1, type: "say", say: "task", text: "legacy task" },
			expect.objectContaining({
				type: "say",
				say: "text",
				text: expect.stringContaining("legacy task"),
			}),
			expect.objectContaining({ type: "ask", ask: "resume_task" }),
		])
	})

	it("does not show a task that is missing from history", async () => {
		const { coordinator, options } = makeCoordinator({ hasHistoryItem: false })

		await coordinator.showTaskWithId("missing-task")

		expect(options.setTask).not.toHaveBeenCalled()
		expect(options.taskHistory.getClineMessages).not.toHaveBeenCalled()
		expect(options.setTurnPhase).not.toHaveBeenCalled()
	})

	it("appends a resume ask and sets the resumable phase when showing an interrupted (cancelled) task", async () => {
		// History rendering appends a synthetic trailing ask:"completion_result"
		// to every reopened conversation, so the persisted session status — not
		// the message tail — must decide the resume affordance.
		const sdkClineMessages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "hello" },
			{ ts: 2, type: "ask", ask: "completion_result", text: "" },
		]
		const { coordinator, options, state } = makeCoordinator({
			hasHistoryItem: true,
			clineMessages: sdkClineMessages,
			sessionStatus: "cancelled",
		})

		await coordinator.showTaskWithId("task-1")

		expect(state.task?.messageStateHandler.getClineMessages().at(-1)).toEqual(
			expect.objectContaining({ type: "ask", ask: "resume_task" }),
		)
		expect(options.setTurnPhase).toHaveBeenCalledWith("resumable", expect.any(Number))
	})

	it("sets the turn phase to resumable when showing a failed task", async () => {
		const sdkClineMessages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "hello" },
			{ ts: 2, type: "say", say: "text", text: "partial answer" },
		]
		const { coordinator, options } = makeCoordinator({
			hasHistoryItem: true,
			clineMessages: sdkClineMessages,
			sessionStatus: "failed",
		})

		await coordinator.showTaskWithId("task-1")

		expect(options.setTurnPhase).toHaveBeenCalledWith("resumable", expect.any(Number))
	})

	it("sets the turn phase to completed when showing a completed task", async () => {
		const sdkClineMessages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "hello" },
			{ ts: 2, type: "ask", ask: "completion_result", text: "" },
		]
		const { coordinator, options, state } = makeCoordinator({
			hasHistoryItem: true,
			clineMessages: sdkClineMessages,
			sessionStatus: "completed",
		})

		await coordinator.showTaskWithId("task-1")

		expect(state.task?.messageStateHandler.getClineMessages().at(-1)).toEqual(
			expect.objectContaining({ type: "ask", ask: "resume_completed_task" }),
		)
		expect(options.setTurnPhase).toHaveBeenCalledWith("completed", expect.any(Number))
	})

	it("sets the turn phase to idle when showing a task with no messages", async () => {
		const { coordinator, options } = makeCoordinator({
			hasHistoryItem: true,
			clineMessages: [],
		})

		await coordinator.showTaskWithId("task-1")

		expect(options.setTurnPhase).toHaveBeenCalledWith("idle")
	})

	it("keeps the newest selection when an older open's history lookup resolves last", async () => {
		const { coordinator, options, state } = makeCoordinator({
			hasHistoryItem: true,
			clineMessages: [{ ts: 1, type: "say", say: "task", text: "hello" }],
			sessionStatus: "cancelled",
		})

		// Task A's preflight history lookup stalls. The view generation must be
		// allocated BEFORE this await: when the lookup used to live in
		// SdkController ahead of the coordinator, a stalled lookup re-entered
		// with a NEWER generation than a later selection and replaced it.
		let resolveLookup: ((item: unknown) => void) | undefined
		options.taskHistory.findHistoryItem.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveLookup = resolve
				}),
		)

		const staleOpen = coordinator.showTaskWithId("task-old")

		// Task B is selected afterwards and loads successfully.
		await coordinator.showTaskWithId("task-new")
		expect(state.task?.taskId).toBe("task-new")
		const endSessionCalls = options.sessions.endSession.mock.calls.length

		// Task A's lookup finally resolves. It must neither stop the session the
		// newer selection installed nor replace the selection.
		resolveLookup?.({ id: "task-old", ts: 1, task: "old", tokensIn: 0, tokensOut: 0, totalCost: 0 })
		const staleResult = await staleOpen

		expect(staleResult).toBeDefined()
		expect(state.task?.taskId).toBe("task-new")
		expect(options.sessions.endSession.mock.calls.length).toBe(endSessionCalls)
	})

	it("abandons a superseded showTaskWithId so the newest selection wins", async () => {
		const { coordinator, options, state } = makeCoordinator({
			hasHistoryItem: true,
			clineMessages: [{ ts: 1, type: "say", say: "task", text: "hello" }],
			sessionStatus: "cancelled",
		})

		// Park the FIRST open on its message read so a second open can start
		// and finish while the first is still in flight.
		let resolveFirstRead: ((messages: ClineMessage[]) => void) | undefined
		options.taskHistory.getClineMessages.mockImplementationOnce(
			() =>
				new Promise<ClineMessage[]>((resolve) => {
					resolveFirstRead = resolve
				}),
		)

		const firstOpen = coordinator.showTaskWithId("task-old")
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(resolveFirstRead).toBeDefined()

		await coordinator.showTaskWithId("task-new")
		expect(state.task?.taskId).toBe("task-new")
		const phaseCallsAfterSecondOpen = options.setTurnPhase.mock.calls.length

		resolveFirstRead?.([{ ts: 1, type: "say", say: "task", text: "stale" }])
		await firstOpen

		// The stale open must not replace the newer selection or its turn phase.
		expect(state.task?.taskId).toBe("task-new")
		expect(state.task?.messageStateHandler.getClineMessages().length).toBeGreaterThan(0)
		expect(options.setTurnPhase.mock.calls.length).toBe(phaseCallsAfterSecondOpen)
	})

	it("abandons a superseded showTaskWithId when the user clears the task", async () => {
		const { coordinator, options, state } = makeCoordinator({
			hasHistoryItem: true,
			clineMessages: [{ ts: 1, type: "say", say: "task", text: "hello" }],
			sessionStatus: "cancelled",
		})

		let resolveRead: ((messages: ClineMessage[]) => void) | undefined
		options.taskHistory.getClineMessages.mockImplementationOnce(
			() =>
				new Promise<ClineMessage[]>((resolve) => {
					resolveRead = resolve
				}),
		)

		const open = coordinator.showTaskWithId("task-old")
		await new Promise((resolve) => setTimeout(resolve, 0))

		await coordinator.clearTask()
		resolveRead?.([{ ts: 1, type: "say", say: "task", text: "stale" }])
		await open

		expect(state.task).toBeUndefined()
	})

	it("does not install the new task proxy until its messages are loaded", async () => {
		const sdkClineMessages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "hello" },
			{ ts: 2, type: "ask", ask: "completion_result", text: "" },
		]

		let resolveGetClineMessages: ((messages: ClineMessage[]) => void) | undefined
		const getClineMessagesDeferred = new Promise<ClineMessage[]>((resolve) => {
			resolveGetClineMessages = resolve
		})

		const { coordinator, options, state } = makeCoordinator({
			hasHistoryItem: true,
			clineMessages: sdkClineMessages,
		})
		options.taskHistory.getClineMessages.mockReturnValueOnce(getClineMessagesDeferred)

		let setTaskHadMessages: boolean | undefined
		options.setTask.mockImplementation((task: any) => {
			setTaskHadMessages = (task?.messageStateHandler?.getClineMessages?.() ?? []).length > 0
			state.task = task
		})

		const inFlight = coordinator.showTaskWithId("task-1")

		// While getClineMessages is still pending, the new task proxy must not be
		// installed — otherwise concurrent postStateToWebview() callers would see
		// currentTaskItem.id with an empty messageStateHandler.
		await Promise.resolve()
		await Promise.resolve()
		expect(options.setTask).not.toHaveBeenCalled()
		expect(state.task).toBeUndefined()

		resolveGetClineMessages?.(sdkClineMessages)
		await inFlight

		expect(options.setTask).toHaveBeenCalledTimes(1)
		expect(setTaskHadMessages).toBe(true)
		expect(state.task?.taskId).toBe("task-1")
		expect(options.postStateToWebview).toHaveBeenCalledOnce()
	})
})

function makeCoordinator(input: Partial<MakeCoordinatorInput> = {}) {
	const state: { task?: ReturnType<typeof makeTask> } = {
		task: input.task,
	}
	const options = {
		sessions: {
			getActiveSession: vi.fn(() => input.activeSession),
			endSession: vi.fn().mockResolvedValue(input.activeSession),
			setRunning: vi.fn(),
			// Cline Cubed: chats coexist, so "is this session still live?" is asked before any
			// teardown — a live session is focused in place, never stopped, and its transcript is
			// never wiped. Nothing is live unless a test says so, which is the single-chat world
			// the assertions below were written in.
			getLiveSession: vi.fn((sessionId: string) =>
				(input.liveSessionIds ?? []).includes(sessionId) ? { sessionId, isRunning: true } : undefined,
			),
		},
		interactions: {
			clearPending: vi.fn(),
		},
		messages: {
			appendAndEmit: vi.fn(),
			appendMessages: vi.fn(),
			cancelPendingSave: vi.fn(),
			finalizeMessagesForSave: vi.fn((messages: ClineMessage[]) =>
				messages.map((message) => {
					if (!message.partial) {
						return message
					}
					const { partial: _partial, ...rest } = message
					return { ...rest, text: "final" }
				}),
			),
		},
		taskHistory: {
			getClineMessages: vi.fn().mockResolvedValue(input.clineMessages ?? []),
			getSessionStatus: vi.fn().mockResolvedValue(input.sessionStatus),
			isLegacyTask: vi.fn().mockResolvedValue(input.isLegacyTask ?? false),
			findHistoryItem: vi.fn(() =>
				input.hasHistoryItem === false
					? undefined
					: {
							id: "task-1",
							ts: 1,
							task: "hello",
							tokensIn: 0,
							tokensOut: 0,
							totalCost: 0,
						},
			),
		},
		getTask: vi.fn(() => state.task),
		setTask: vi.fn((task) => {
			state.task = task as ReturnType<typeof makeTask> | undefined
		}),
		onAskResponse: vi.fn().mockResolvedValue(undefined),
		resetMessageTranslator: vi.fn(),
		raiseCancelFence: vi.fn(),
		setTurnPhase: vi.fn(),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		clearTaskSettings: vi.fn().mockResolvedValue(undefined),
	} as unknown as SdkTaskControlCoordinatorOptions & {
		sessions: SdkTaskControlCoordinatorOptions["sessions"] & {
			getActiveSession: ReturnType<typeof vi.fn>
			endSession: ReturnType<typeof vi.fn>
			setRunning: ReturnType<typeof vi.fn>
			getLiveSession: ReturnType<typeof vi.fn>
		}
		interactions: SdkTaskControlCoordinatorOptions["interactions"] & { clearPending: ReturnType<typeof vi.fn> }
		messages: SdkTaskControlCoordinatorOptions["messages"] & {
			appendAndEmit: ReturnType<typeof vi.fn>
			appendMessages: ReturnType<typeof vi.fn>
			cancelPendingSave: ReturnType<typeof vi.fn>
			finalizeMessagesForSave: ReturnType<typeof vi.fn>
		}
		taskHistory: SdkTaskControlCoordinatorOptions["taskHistory"] & {
			findHistoryItem: ReturnType<typeof vi.fn>
			getClineMessages: ReturnType<typeof vi.fn>
			isLegacyTask: ReturnType<typeof vi.fn>
		}
		getTask: ReturnType<typeof vi.fn>
		setTask: ReturnType<typeof vi.fn>
		resetMessageTranslator: ReturnType<typeof vi.fn>
		setTurnPhase: ReturnType<typeof vi.fn>
		postStateToWebview: ReturnType<typeof vi.fn>
		clearTaskSettings: ReturnType<typeof vi.fn>
	}

	return {
		coordinator: new SdkTaskControlCoordinator(options),
		options,
		state,
	}
}

interface MakeCoordinatorInput {
	activeSession: ReturnType<typeof makeActiveSession>
	task: ReturnType<typeof makeTask>
	hasHistoryItem: boolean
	clineMessages: ClineMessage[]
	isLegacyTask: boolean
	sessionStatus: string
	/** Session ids that are still LIVE — a live chat is focused in place, never torn down. */
	liveSessionIds: string[]
}

function makeActiveSession() {
	return {
		sessionId: "session-123",
		sdkHost: {
			abort: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn().mockResolvedValue(undefined),
		},
		unsubscribe: vi.fn(),
		isRunning: true,
	}
}

function makeTask(taskId: string, messages: ClineMessage[] = []) {
	return {
		taskId,
		messageStateHandler: {
			getClineMessages: vi.fn(() => messages),
			clear: vi.fn(),
		},
	}
}
