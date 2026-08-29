import type { AgentEvent } from "@cline/shared"
import { describe, expect, it, vi } from "vitest"
import { MessageTranslatorState, translateSessionEvent } from "./message-translator"
import { SdkInteractionCoordinator } from "./sdk-interaction-coordinator"
import { SdkMessageCoordinator } from "./sdk-message-coordinator"
import { MISTAKE_LIMIT_SESSION_ID } from "./sdk-session-lifecycle"
import { createTaskProxy } from "./task-proxy"
import { DEFAULT_TOOL_APPROVAL_DENIAL_REASON, EDIT_TOOL_APPROVAL_DENIAL_REASON } from "./tool-approval-denial"

vi.mock("./webview-grpc-bridge", () => ({
	pushMessageToWebview: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@core/storage/disk", () => ({
	saveClineMessages: vi.fn().mockResolvedValue(undefined),
}))

describe("SdkInteractionCoordinator", () => {
	it("emits a tool approval ask and resolves approval from askResponse state", async () => {
		const task = createTaskProxy("session-123", vi.fn(), vi.fn())
		const messages = new SdkMessageCoordinator({ getTask: () => task })
		const listener = vi.fn()
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const recordApprovedToolMessage = vi.fn()
		const coordinator = new SdkInteractionCoordinator({
			messages,
			getSessionId: () => "session-123",
			postStateToWebview,
			recordApprovedToolMessage,
		})
		messages.onSessionEvent(listener)

		const approvalPromise = coordinator.handleRequestToolApproval({
			agentId: "agent",
			conversationId: "session-123",
			iteration: 1,
			toolCallId: "tool-call",
			toolName: "read_files",
			input: { path: "README.md" },
			policy: { autoApprove: false },
		})
		await vi.waitFor(() => expect(postStateToWebview).toHaveBeenCalled())

		const clineMessages = task.messageStateHandler.getClineMessages()
		expect(clineMessages).toHaveLength(1)
		expect(clineMessages[0].type).toBe("ask")
		expect(clineMessages[0].ask).toBe("tool")
		expect(JSON.parse(clineMessages[0].text || "{}")).toMatchObject({ tool: "readFile", path: "README.md" })
		expect(listener).toHaveBeenCalledOnce()

		expect(coordinator.resolvePendingToolApproval("session-123", undefined, "yesButtonClicked")).toBe(true)
		expect(recordApprovedToolMessage).toHaveBeenCalledWith("tool-call", clineMessages[0].ts)
		await expect(approvalPromise).resolves.toEqual({ approved: true })
	})

	it("records the real approval row timestamp that the translator reuses", async () => {
		const task = createTaskProxy("session-123", vi.fn(), vi.fn())
		const messages = new SdkMessageCoordinator({ getTask: () => task })
		const state = new MessageTranslatorState()
		const coordinator = new SdkInteractionCoordinator({
			messages,
			getSessionId: () => "session-123",
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			getMinter: () => state.getMinter(),
			recordApprovedToolMessage: (toolCallId, messageTs) => state.recordApprovedToolMessageTs(toolCallId, messageTs),
		})

		const approvalPromise = coordinator.handleRequestToolApproval({
			agentId: "agent",
			conversationId: "session-123",
			iteration: 1,
			toolCallId: "tool-call",
			toolName: "editor",
			input: { path: "calculator.py", old_text: "# comment", new_text: "" },
			policy: { autoApprove: false },
		})
		await vi.waitFor(() => expect(task.messageStateHandler.getClineMessages()).toHaveLength(1))
		const approvalTs = task.messageStateHandler.getClineMessages()[0].ts

		expect(coordinator.resolvePendingToolApproval("session-123", undefined, "yesButtonClicked")).toBe(true)
		await expect(approvalPromise).resolves.toEqual({ approved: true })

		const result = translateSessionEvent(
			{
				type: "agent_event",
				payload: {
					sessionId: "session-123",
					event: {
						type: "content_start",
						contentType: "tool",
						toolName: "editor",
						toolCallId: "tool-call",
						input: { path: "calculator.py", old_text: "# comment", new_text: "" },
					} as AgentEvent,
				},
			},
			state,
		)

		expect(result.messages[0]).toMatchObject({ ts: approvalTs, type: "say", say: "tool", partial: true })
	})

	it("resolves denied tool approval with the user reason", async () => {
		const task = createTaskProxy("session-123", vi.fn(), vi.fn())
		const recordApprovedToolMessage = vi.fn()
		const recordDeniedToolApproval = vi.fn()
		const messages = new SdkMessageCoordinator({ getTask: () => task })
		const coordinator = new SdkInteractionCoordinator({
			messages,
			getSessionId: () => "session-123",
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			recordApprovedToolMessage,
			recordDeniedToolApproval,
		})

		const approvalPromise = coordinator.handleRequestToolApproval({
			agentId: "agent",
			conversationId: "session-123",
			iteration: 1,
			toolCallId: "tool-call",
			toolName: "execute_command",
			input: { command: "npm test" },
			policy: { autoApprove: false },
		})
		await vi.waitFor(() => expect(task.messageStateHandler.getClineMessages()).toHaveLength(1))

		const clineMessages = task.messageStateHandler.getClineMessages()
		expect(clineMessages[0]).toMatchObject({ type: "ask", ask: "command", text: "npm test" })

		expect(
			coordinator.resolvePendingToolApproval("session-123", "too risky", "noButtonClicked", ["image.png"], ["a.ts"]),
		).toBe(true)
		expect(recordApprovedToolMessage).not.toHaveBeenCalled()
		const expectedReason = `${DEFAULT_TOOL_APPROVAL_DENIAL_REASON} The user provided the following feedback:\n<feedback>\ntoo risky\n</feedback>`
		expect(recordDeniedToolApproval).toHaveBeenCalledWith("tool-call", "execute_command", expectedReason)
		expect(task.messageStateHandler.getClineMessages()[1]).toMatchObject({
			type: "say",
			say: "user_feedback",
			text: "too risky",
			images: ["image.png"],
			files: ["a.ts"],
			partial: false,
		})
		await expect(approvalPromise).resolves.toEqual({ approved: false, reason: expectedReason })
	})

	it("denies edit tools with an explicit file-was-not-modified reason", async () => {
		const task = createTaskProxy("session-123", vi.fn(), vi.fn())
		const coordinator = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => task }),
			getSessionId: () => "session-123",
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})

		const approvalPromise = coordinator.handleRequestToolApproval({
			agentId: "agent",
			conversationId: "session-123",
			iteration: 1,
			toolCallId: "tool-call",
			toolName: "editor",
			input: { path: "a.ts", old_text: "a", new_text: "b" },
			policy: { autoApprove: false },
		})
		await vi.waitFor(() => expect(task.messageStateHandler.getClineMessages()).toHaveLength(1))

		// Feedback typed into the approval row denies the edit; the model-facing reason must
		// state the file is unchanged, or it will treat the feedback as iteration on an
		// applied edit and target old_text at content that never landed on disk.
		expect(coordinator.resolvePendingToolApproval("session-123", "make them bigger", "noButtonClicked")).toBe(true)
		const result = await approvalPromise
		expect(result.approved).toBe(false)
		expect(result.reason).toContain("The file was NOT modified")
		expect(result.reason).toContain("<feedback>\nmake them bigger\n</feedback>")

		// Plain rejection (no feedback) also carries the file-unchanged statement.
		const secondApproval = coordinator.handleRequestToolApproval({
			agentId: "agent",
			conversationId: "session-123",
			iteration: 2,
			toolCallId: "tool-call-2",
			toolName: "editor",
			input: { path: "a.ts", old_text: "a", new_text: "b" },
			policy: { autoApprove: false },
		})
		// Prior messages: ask #1 + the user_feedback say from the first denial.
		await vi.waitFor(() => expect(task.messageStateHandler.getClineMessages().length).toBeGreaterThanOrEqual(3))
		expect(coordinator.resolvePendingToolApproval("session-123", undefined, "noButtonClicked")).toBe(true)
		await expect(secondApproval).resolves.toEqual({ approved: false, reason: EDIT_TOOL_APPROVAL_DENIAL_REASON })
	})

	it("routes message responses as queued follow-ups without resolving pending tool approval", async () => {
		const task = createTaskProxy("session-123", vi.fn(), vi.fn())
		const setTurnPhase = vi.fn()
		const recordDeniedToolApproval = vi.fn()
		const coordinator = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => task }),
			getSessionId: () => "session-123",
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			setTurnPhase,
			recordDeniedToolApproval,
		})

		const approvalPromise = coordinator.handleRequestToolApproval({
			agentId: "agent",
			conversationId: "session-123",
			iteration: 1,
			toolCallId: "tool-call",
			toolName: "fetch_web_content",
			input: { requests: [{ url: "https://example.com", prompt: "read it" }] },
			policy: { autoApprove: false },
		})
		await vi.waitFor(() => expect(task.messageStateHandler.getClineMessages()).toHaveLength(1))

		expect(coordinator.resolvePendingToolApproval("session-123", "just give me an answer", "messageResponse")).toBe(false)
		expect(recordDeniedToolApproval).not.toHaveBeenCalled()
		expect(setTurnPhase).toHaveBeenLastCalledWith(
			"awaiting_approval",
			task.messageStateHandler.getClineMessages()[0].ts,
			"session-123",
		)

		expect(coordinator.resolvePendingToolApproval("session-123", undefined, "yesButtonClicked")).toBe(true)
		await expect(approvalPromise).resolves.toEqual({ approved: true })
	})

	it("records generic no-button approval denials for UI suppression", async () => {
		const task = createTaskProxy("session-123", vi.fn(), vi.fn())
		const recordDeniedToolApproval = vi.fn()
		const coordinator = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => task }),
			getSessionId: () => "session-123",
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			recordDeniedToolApproval,
		})

		const approvalPromise = coordinator.handleRequestToolApproval({
			agentId: "agent",
			conversationId: "session-123",
			iteration: 1,
			toolCallId: "tool-call",
			toolName: "fetch_web_content",
			input: { requests: [{ url: "https://example.com", prompt: "read it" }] },
			policy: { autoApprove: false },
		})
		await vi.waitFor(() => expect(task.messageStateHandler.getClineMessages()).toHaveLength(1))

		expect(coordinator.resolvePendingToolApproval("session-123", undefined, "noButtonClicked")).toBe(true)
		await expect(approvalPromise).resolves.toEqual({
			approved: false,
			reason: DEFAULT_TOOL_APPROVAL_DENIAL_REASON,
		})
		expect(task.messageStateHandler.getClineMessages()).toHaveLength(1)
		expect(recordDeniedToolApproval).toHaveBeenCalledWith(
			"tool-call",
			"fetch_web_content",
			DEFAULT_TOOL_APPROVAL_DENIAL_REASON,
		)
	})

	it("auto-approves without emitting UI when the live settings allow the tool", async () => {
		const task = createTaskProxy("session-123", vi.fn(), vi.fn())
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const recordApprovedToolMessage = vi.fn()
		const coordinator = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => task }),
			getSessionId: () => "session-123",
			postStateToWebview,
			shouldAutoApproveTool: () => true,
			recordApprovedToolMessage,
		})

		await expect(
			coordinator.handleRequestToolApproval({
				agentId: "agent",
				conversationId: "session-123",
				iteration: 1,
				toolCallId: "tool-call",
				toolName: "run_commands",
				input: { command: "npm test" },
				policy: { autoApprove: false },
			}),
		).resolves.toEqual({ approved: true })

		expect(task.messageStateHandler.getClineMessages()).toHaveLength(0)
		expect(postStateToWebview).not.toHaveBeenCalled()
		expect(recordApprovedToolMessage).not.toHaveBeenCalled()
	})

	it("auto-approves without emitting UI when the SDK policy already allows the tool", async () => {
		const task = createTaskProxy("session-123", vi.fn(), vi.fn())
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const recordApprovedToolMessage = vi.fn()
		const coordinator = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => task }),
			getSessionId: () => "session-123",
			postStateToWebview,
			shouldAutoApproveTool: () => false,
			recordApprovedToolMessage,
		})

		await expect(
			coordinator.handleRequestToolApproval({
				agentId: "agent",
				conversationId: "session-123",
				iteration: 1,
				toolCallId: "tool-call",
				toolName: "run_commands",
				input: { command: "npm test" },
				policy: { autoApprove: true },
			}),
		).resolves.toEqual({ approved: true })

		expect(task.messageStateHandler.getClineMessages()).toHaveLength(0)
		expect(postStateToWebview).not.toHaveBeenCalled()
		expect(recordApprovedToolMessage).not.toHaveBeenCalled()
	})

	it("emits an MCP approval ask with server, tool, and arguments", async () => {
		const task = createTaskProxy("session-123", vi.fn(), vi.fn())
		const coordinator = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => task }),
			getSessionId: () => "session-123",
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})

		void coordinator.handleRequestToolApproval({
			agentId: "agent",
			conversationId: "session-123",
			iteration: 1,
			toolCallId: "tool-call",
			toolName: "github__search-repos",
			input: { query: "cline" },
			policy: { autoApprove: false },
		})
		await vi.waitFor(() => expect(task.messageStateHandler.getClineMessages()).toHaveLength(1))

		const [message] = task.messageStateHandler.getClineMessages()
		expect(message).toMatchObject({ type: "ask", ask: "use_mcp_server", partial: false })
		expect(JSON.parse(message.text || "{}")).toEqual({
			type: "use_mcp_tool",
			serverName: "github",
			toolName: "search-repos",
			arguments: '{\n  "query": "cline"\n}',
		})
	})

	it("emits ask_question and resolves it with rendered user feedback", async () => {
		const task = createTaskProxy("session-123", vi.fn(), vi.fn())
		const messages = new SdkMessageCoordinator({ getTask: () => task })
		const coordinator = new SdkInteractionCoordinator({
			messages,
			getSessionId: () => "session-123",
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})

		const answerPromise = coordinator.handleAskQuestion("Continue?", ["Yes"], { sessionId: "session-123" })
		await vi.waitFor(() => expect(task.messageStateHandler.getClineMessages()).toHaveLength(1))

		await new Promise((resolve) => setTimeout(resolve, 1))
		expect(coordinator.resolvePendingAskQuestion("session-123", "yes")).toBe(true)
		await expect(answerPromise).resolves.toBe("yes")
		expect(task.messageStateHandler.getClineMessages()).toMatchObject([
			{ type: "ask", ask: "followup" },
			{ type: "say", say: "user_feedback", text: "yes" },
		])
	})

	it("shows an error row and stops immediately when the mistake limit is reached", async () => {
		const task = createTaskProxy("session-123", vi.fn(), vi.fn())
		const setTurnPhase = vi.fn()
		const coordinator = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => task }),
			getSessionId: () => "session-123",
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			setTurnPhase,
		})

		// CLI parity: the decision resolves right away as a stop — no pending
		// prompt that would leave the agent loop running against the provider.
		await expect(
			coordinator.handleConsecutiveMistakeLimitReached({
				iteration: 4,
				consecutiveMistakes: 3,
				maxConsecutiveMistakes: 3,
				reason: "tool_execution_failed",
				details: "bad arguments",
			}),
		).resolves.toEqual({
			action: "stop",
			reason: "mistake_limit_reached: tool_execution_failed: bad arguments",
		})

		expect(task.messageStateHandler.getClineMessages()).toMatchObject([
			{
				type: "say",
				say: "error",
				partial: false,
			},
		])
		const errorText = task.messageStateHandler.getClineMessages()[0].text ?? ""
		expect(errorText).toContain("3 errors in a row")
		expect(errorText).toContain("tool_execution_failed: bad arguments")
		expect(errorText).toContain("Send a message to give Cline guidance")
	})

	it("puts a mistake-limit error row in the session that hit the limit, not the focused chat", async () => {
		// The SDK's context names no session, so the id is stamped on at session start. A
		// background chat reaching its limit must show the row in ITS OWN transcript.
		const focused = createTaskProxy("chat-focused", vi.fn(), vi.fn())
		const background = createTaskProxy("chat-background", vi.fn(), vi.fn())
		const setTurnPhase = vi.fn()
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const coordinator = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({
				getTask: (sessionId) => (sessionId === "chat-background" ? background : focused),
			}),
			getSessionId: () => "chat-focused",
			postStateToWebview,
			setTurnPhase,
		})

		await coordinator.handleConsecutiveMistakeLimitReached({
			iteration: 4,
			consecutiveMistakes: 3,
			maxConsecutiveMistakes: 3,
			reason: "tool_execution_failed",
			[MISTAKE_LIMIT_SESSION_ID]: "chat-background",
		} as never)

		expect(background.messageStateHandler.getClineMessages()).toMatchObject([{ type: "say", say: "error" }])
		expect(focused.messageStateHandler.getClineMessages()).toHaveLength(0)
		expect(setTurnPhase).toHaveBeenCalledWith("error", undefined, "chat-background")
		expect(postStateToWebview).toHaveBeenCalledWith("chat-background")
	})

	it("summarizes the mistake limit without details using the iteration", async () => {
		const task = createTaskProxy("session-123", vi.fn(), vi.fn())
		const coordinator = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => task }),
			getSessionId: () => "session-123",
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})

		await expect(
			coordinator.handleConsecutiveMistakeLimitReached({
				iteration: 4,
				consecutiveMistakes: 3,
				maxConsecutiveMistakes: 3,
				reason: "tool_execution_failed",
			}),
		).resolves.toEqual({
			action: "stop",
			reason: "mistake_limit_reached: tool_execution_failed at iteration 4",
		})
	})

	it("clears pending tool approvals as rejected", async () => {
		const task = createTaskProxy("session-123", vi.fn(), vi.fn())
		const recordDeniedToolApproval = vi.fn()
		const coordinator = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => task }),
			getSessionId: () => "session-123",
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			recordDeniedToolApproval,
		})

		const approvalPromise = coordinator.handleRequestToolApproval({
			agentId: "agent",
			conversationId: "session-123",
			iteration: 1,
			toolCallId: "tool-call",
			toolName: "read_files",
			input: {},
			policy: { autoApprove: false },
		})
		await vi.waitFor(() => expect(task.messageStateHandler.getClineMessages()).toHaveLength(1))

		coordinator.clearPending("Task cancelled", "session-123")

		await expect(approvalPromise).resolves.toEqual({ approved: false, reason: "Task cancelled" })
		expect(recordDeniedToolApproval).toHaveBeenCalledWith("tool-call", "read_files", "Task cancelled")
		expect(coordinator.resolvePendingToolApproval("session-123", undefined, "yesButtonClicked")).toBe(false)
	})

	it("awaits onToolApprovalAsk before emitting the approval ask", async () => {
		const task = createTaskProxy("session-123", vi.fn(), vi.fn())
		const events: string[] = []
		let releaseHook: () => void = () => {}
		const onToolApprovalAsk = vi.fn().mockImplementation(async () => {
			events.push("hook-start")
			await new Promise<void>((resolve) => {
				releaseHook = resolve
			})
			events.push("hook-end")
		})
		const coordinator = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => task }),
			getSessionId: () => "session-123",
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			onToolApprovalAsk,
		})

		const approvalPromise = coordinator.handleRequestToolApproval({
			agentId: "agent",
			conversationId: "session-123",
			iteration: 1,
			toolCallId: "tool-call",
			toolName: "editor",
			input: { path: "a.ts", old_text: "a", new_text: "b" },
			policy: { autoApprove: false },
		})

		await vi.waitFor(() => expect(events).toEqual(["hook-start"]))
		// The ask message must not exist while the diff preview is still opening.
		expect(task.messageStateHandler.getClineMessages()).toHaveLength(0)

		releaseHook()
		await vi.waitFor(() => expect(task.messageStateHandler.getClineMessages()).toHaveLength(1))
		expect(onToolApprovalAsk).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "tool-call", toolName: "editor" }))

		expect(coordinator.resolvePendingToolApproval("session-123", undefined, "yesButtonClicked")).toBe(true)
		await expect(approvalPromise).resolves.toEqual({ approved: true })
	})

	it("does not invoke onToolApprovalAsk for auto-approved tools", async () => {
		const onToolApprovalAsk = vi.fn().mockResolvedValue(undefined)
		const coordinator = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => createTaskProxy("session-123", vi.fn(), vi.fn()) }),
			getSessionId: () => "session-123",
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			shouldAutoApproveTool: () => true,
			onToolApprovalAsk,
		})

		await expect(
			coordinator.handleRequestToolApproval({
				agentId: "agent",
				conversationId: "session-123",
				iteration: 1,
				toolCallId: "tool-call",
				toolName: "editor",
				input: { path: "a.ts", old_text: "a", new_text: "b" },
				policy: { autoApprove: false },
			}),
		).resolves.toEqual({ approved: true })
		expect(onToolApprovalAsk).not.toHaveBeenCalled()
	})

	it("keys and resolves pendings PER SESSION — another chat's response resolves nothing", async () => {
		// Chat A asks a follow-up question while chat B is the FOCUSED session. The ask row must
		// render in A, a response from B must not consume it, and A's own response must.
		const taskA = createTaskProxy("chat-a", vi.fn(), vi.fn())
		const taskB = createTaskProxy("chat-b", vi.fn(), vi.fn())
		const messages = new SdkMessageCoordinator({
			getTask: (sessionId) => (sessionId === "chat-a" ? taskA : taskB),
		})
		const coordinator = new SdkInteractionCoordinator({
			messages,
			// The FOCUSED session is B — the old single-slot coordinator attributed everything here.
			getSessionId: () => "chat-b",
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})

		const answerPromise = coordinator.handleAskQuestion("Continue?", [], { sessionId: "chat-a" })
		await vi.waitFor(() => expect(taskA.messageStateHandler.getClineMessages()).toHaveLength(1))
		// The ask row belongs to the ASKING chat, not the focused one.
		expect(taskA.messageStateHandler.getClineMessages()[0]).toMatchObject({ type: "ask", ask: "followup" })
		expect(taskB.messageStateHandler.getClineMessages()).toHaveLength(0)

		// A message from chat B resolves NOTHING and echoes nowhere.
		expect(coordinator.resolvePendingAskQuestion("chat-b", "typed into the other chat")).toBe(false)
		expect(taskB.messageStateHandler.getClineMessages()).toHaveLength(0)
		expect(coordinator.hasPendingFor("chat-a")).toBe(true)

		// Chat A's own response lands, and its echo renders in chat A.
		expect(coordinator.resolvePendingAskQuestion("chat-a", "the real answer")).toBe(true)
		await expect(answerPromise).resolves.toBe("the real answer")
		expect(taskA.messageStateHandler.getClineMessages()[1]).toMatchObject({
			type: "say",
			say: "user_feedback",
			text: "the real answer",
		})
	})

	it("holds two chats' pendings at once and resolves each independently", async () => {
		const taskA = createTaskProxy("chat-a", vi.fn(), vi.fn())
		const taskB = createTaskProxy("chat-b", vi.fn(), vi.fn())
		const coordinator = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: (sessionId) => (sessionId === "chat-a" ? taskA : taskB) }),
			getSessionId: () => "chat-a",
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})

		const questionPromise = coordinator.handleAskQuestion("Which?", [], { sessionId: "chat-a" })
		const approvalPromise = coordinator.handleRequestToolApproval({
			agentId: "agent",
			conversationId: "chat-b",
			iteration: 1,
			toolCallId: "tool-call-b",
			toolName: "read_files",
			input: {},
			policy: { autoApprove: false },
		})
		await vi.waitFor(() => expect(taskB.messageStateHandler.getClineMessages()).toHaveLength(1))
		expect(coordinator.hasPendingFor("chat-a")).toBe(true)
		expect(coordinator.hasPendingFor("chat-b")).toBe(true)

		// Approving B touches only B; A's question is still pending.
		expect(coordinator.resolvePendingToolApproval("chat-b", undefined, "yesButtonClicked")).toBe(true)
		await expect(approvalPromise).resolves.toEqual({ approved: true })
		expect(coordinator.hasPendingFor("chat-a")).toBe(true)

		expect(coordinator.resolvePendingAskQuestion("chat-a", "A's answer")).toBe(true)
		await expect(questionPromise).resolves.toBe("A's answer")
	})

	it("clears ONE session's pendings and leaves every other chat's intact", async () => {
		const taskA = createTaskProxy("chat-a", vi.fn(), vi.fn())
		const taskB = createTaskProxy("chat-b", vi.fn(), vi.fn())
		const coordinator = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: (sessionId) => (sessionId === "chat-a" ? taskA : taskB) }),
			getSessionId: () => "chat-a",
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})

		const questionA = coordinator.handleAskQuestion("A?", [], { sessionId: "chat-a" })
		const questionB = coordinator.handleAskQuestion("B?", [], { sessionId: "chat-b" })
		await vi.waitFor(() => expect(taskB.messageStateHandler.getClineMessages()).toHaveLength(1))

		coordinator.clearPending("Task cancelled", "chat-a")
		await expect(questionA).resolves.toBe("")
		expect(coordinator.hasPendingFor("chat-a")).toBe(false)
		expect(coordinator.hasPendingFor("chat-b")).toBe(true)

		expect(coordinator.resolvePendingAskQuestion("chat-b", "still here")).toBe(true)
		await expect(questionB).resolves.toBe("still here")
	})

	it("falls back to the focused session (with a live-session validator) when an ask's identity names no live session", async () => {
		const taskA = createTaskProxy("chat-a", vi.fn(), vi.fn())
		const coordinator = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => taskA }),
			getSessionId: () => "chat-a",
			// A rotated conversation id maps to no live session; only chat-a is live.
			isLiveSession: (sessionId) => sessionId === "chat-a",
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})

		const approvalPromise = coordinator.handleRequestToolApproval({
			agentId: "agent-x",
			conversationId: "rotated-conversation",
			iteration: 1,
			toolCallId: "tool-call",
			toolName: "read_files",
			input: {},
			policy: { autoApprove: false },
		})
		await vi.waitFor(() => expect(taskA.messageStateHandler.getClineMessages()).toHaveLength(1))

		// Keyed under the focused session, so it stays reachable rather than stranded.
		expect(coordinator.resolvePendingToolApproval("rotated-conversation", undefined, "yesButtonClicked")).toBe(false)
		expect(coordinator.resolvePendingToolApproval("chat-a", undefined, "yesButtonClicked")).toBe(true)
		await expect(approvalPromise).resolves.toEqual({ approved: true })
	})

	it("still shows the approval ask when onToolApprovalAsk throws", async () => {
		const task = createTaskProxy("session-123", vi.fn(), vi.fn())
		const coordinator = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => task }),
			getSessionId: () => "session-123",
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			onToolApprovalAsk: vi.fn().mockRejectedValue(new Error("preview failed")),
		})

		const approvalPromise = coordinator.handleRequestToolApproval({
			agentId: "agent",
			conversationId: "session-123",
			iteration: 1,
			toolCallId: "tool-call",
			toolName: "editor",
			input: { path: "a.ts", old_text: "a", new_text: "b" },
			policy: { autoApprove: false },
		})

		await vi.waitFor(() => expect(task.messageStateHandler.getClineMessages()).toHaveLength(1))
		expect(coordinator.resolvePendingToolApproval("session-123", undefined, "yesButtonClicked")).toBe(true)
		await expect(approvalPromise).resolves.toEqual({ approved: true })
	})
})
