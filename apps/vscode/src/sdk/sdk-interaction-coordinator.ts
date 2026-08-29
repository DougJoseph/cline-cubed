import type { ConsecutiveMistakeLimitContext, ConsecutiveMistakeLimitDecision } from "@cline/shared"
import type { ClineAskQuestion, ClineMessage, TurnPhase } from "@shared/ExtensionMessage"
import type { ClineAskResponse } from "@shared/WebviewMessage"
import { Logger } from "@/shared/services/Logger"
import { MessageIdMinter } from "./message-id-minter"
import { buildToolApprovalAskMessage } from "./message-translator"
import type { SdkMessageCoordinator } from "./sdk-message-coordinator"
import { mistakeLimitSessionId } from "./sdk-session-lifecycle"
import { buildToolApprovalDenialReason } from "./tool-approval-denial"

export interface ToolApprovalRequest {
	agentId: string
	conversationId: string
	iteration: number
	toolCallId: string
	toolName: string
	input: unknown
	policy: { enabled?: boolean; autoApprove?: boolean }
}

/** The identity fields an SDK ask can carry; whichever names a live session wins. */
interface AskIdentity {
	sessionId?: string
	conversationId?: string
	agentId?: string
}

export interface SdkInteractionCoordinatorOptions {
	messages: SdkMessageCoordinator
	/**
	 * The focused session's id — the FALLBACK key for an ask whose own identity fields name no
	 * live session. Chats run side by side, so the fallback is a degraded path and is logged as
	 * one; every well-formed ask carries its session in its identity fields.
	 */
	getSessionId: () => string
	/**
	 * Cline Cubed: whether `sessionId` names a LIVE session. Used to validate an ask's claimed
	 * identity before keying a pending under it — an id that maps to no live session (e.g. a
	 * rotated conversation id) would strand the pending where no response can reach it. Optional
	 * for tests; without it any non-empty claimed id is trusted.
	 */
	isLiveSession?: (sessionId: string) => boolean
	/** Cline Cubed: `sessionId` scopes the state post to the asking chat. */
	postStateToWebview: (sessionId?: string) => Promise<void>
	shouldAutoApproveTool?: (request: ToolApprovalRequest) => boolean
	recordApprovedToolMessage?: (toolCallId: string, messageTs: number) => void
	recordDeniedToolApproval?: (toolCallId: string, toolName: string, reason: string) => void
	/**
	 * The process-wide id/seq/epoch authority, shared with the message translator. Optional so
	 * existing tests that don't need cross-generator id uniqueness keep working; when omitted a
	 * private minter is used. Production wires the shared minter from MessageTranslatorState.
	 */
	getMinter?: () => MessageIdMinter
	/**
	 * Set the authoritative UI turn phase FOR A SESSION. Called when an approval/ask is pending
	 * (awaiting_approval / awaiting_followup) and when the user responds (back to streaming).
	 * `sessionId` is the ASKING chat's session — never the focused chat's. Optional for tests.
	 */
	setTurnPhase?: (phase: TurnPhase, anchorTs?: number, sessionId?: string) => void
	/**
	 * Invoked for manually-approved tools after the auto-approve short-circuit, BEFORE the
	 * ask message is emitted. Used to open the edit diff preview so the user decides while
	 * looking at the actual change. Must not throw; failures fall back to a plain ask.
	 */
	onToolApprovalAsk?: (request: ToolApprovalRequest) => Promise<void>
	/**
	 * The task's working directory, used to relativize the absolute filesystem paths
	 * shown in tool-approval asks (display only). Optional for tests.
	 */
	getCwd?: () => string | undefined
}

interface PendingToolApproval {
	resolve: (result: { approved: boolean; reason?: string }) => void
	toolCallId: string
	messageTs: number
	toolName: string
}

/**
 * Pending interactions (follow-up questions and tool approvals), keyed PER SESSION.
 *
 * Cline Cubed: chats run side by side, so a pending ask belongs to the chat that asked — a
 * response typed in another chat must never resolve it, its ask row and its answer echo must
 * render in the asking chat, and clearing one chat's pendings must leave every other chat's
 * intact. A single-slot, session-blind store cannot honour any of that: a typed message is
 * consumed as another chat's answer and echoed into whichever chat is focused.
 */
export class SdkInteractionCoordinator {
	private readonly pendingAskResolves = new Map<string, (answer: string) => void>()
	private readonly pendingToolApprovals = new Map<string, PendingToolApproval>()

	constructor(private readonly options: SdkInteractionCoordinatorOptions) {}

	/**
	 * The session an ask belongs to. Prefers the ask's own identity fields, validated against
	 * the live-session map when a validator is wired; falls back to the focused session with a
	 * logged warning, because a mis-keyed pending is unreachable by its own chat's responses.
	 */
	private askSessionId(identity: AskIdentity): string {
		const candidates = [identity.sessionId, identity.conversationId, identity.agentId]
		for (const candidate of candidates) {
			const trimmed = candidate?.trim()
			if (!trimmed) {
				continue
			}
			if (!this.options.isLiveSession || this.options.isLiveSession(trimmed)) {
				return trimmed
			}
		}
		const fallback = this.options.getSessionId()
		Logger.warn(
			`[SdkController] Ask carried no live-session identity (sessionId=${identity.sessionId ?? "-"}, ` +
				`conversationId=${identity.conversationId ?? "-"}, agentId=${identity.agentId ?? "-"}); ` +
				`keying pending under the focused session: ${fallback || "(none)"}`,
		)
		return fallback
	}

	/**
	 * CLI-parity mistake-limit handling: show an error row and stop the run
	 * immediately. The session stays resumable, so the user continues
	 * whenever they want by sending a new message (which also resets the
	 * SDK's mistake tracking). A blocking ask here would leave the agent
	 * loop running against the provider while the prompt sits unanswered.
	 *
	 * Cline Cubed: the row belongs to the run that hit the limit. The SDK's context names no
	 * session, so the id is stamped onto it when the session starts and read back here; the
	 * focused session is used only when nothing stamped it (tests, standalone host).
	 */
	async handleConsecutiveMistakeLimitReached(
		context: ConsecutiveMistakeLimitContext,
	): Promise<ConsecutiveMistakeLimitDecision> {
		const detail = context.details?.trim()
		const latest = detail ? `${context.reason}: ${detail}` : `${context.reason} at iteration ${context.iteration}`
		const sessionId = mistakeLimitSessionId(context) ?? this.options.getSessionId()
		const errorMessage: ClineMessage = {
			ts: this.nextMessageTs(),
			type: "say",
			say: "error",
			text: `Cline ran into ${context.consecutiveMistakes} errors in a row and stopped the task.\n\nLatest: ${latest}\n\nSend a message to give Cline guidance and continue the task.`,
			partial: false,
		}

		this.options.messages.appendAndEmit([errorMessage], {
			type: "status",
			payload: { sessionId, status: "running" },
		})
		// The run is stopping, so that chat's footer must leave the thinking state — and it is
		// THAT chat's phase, not the focused one's.
		this.options.setTurnPhase?.("error", undefined, sessionId || undefined)
		await this.options.postStateToWebview(sessionId || undefined)

		return { action: "stop", reason: `mistake_limit_reached: ${latest}` }
	}

	async handleRequestToolApproval(request: ToolApprovalRequest): Promise<{ approved: boolean; reason?: string }> {
		if (request.policy.autoApprove === true || this.options.shouldAutoApproveTool?.(request) === true) {
			Logger.log(`[SdkController] Auto-approving tool execution: tool=${request.toolName}`)
			return { approved: true }
		}

		const sessionId = this.askSessionId(request)

		// Open the edit diff preview before the Approve/Reject buttons render. This is the only
		// pre-execution point where the adapter has the full tool input (the SDK emits the
		// tool's content events only after approval resolves).
		try {
			await this.options.onToolApprovalAsk?.(request)
		} catch (error) {
			Logger.warn(`[SdkController] onToolApprovalAsk failed; showing plain approval ask: ${error}`)
		}

		const toolAskMessage: ClineMessage = buildToolApprovalAskMessage(
			request.toolName,
			request.input,
			this.nextMessageTs(),
			this.options.getCwd?.(),
		)

		this.options.messages.appendAndEmit([toolAskMessage], {
			type: "status",
			payload: { sessionId, status: "running" },
		})
		this.options.setTurnPhase?.("awaiting_approval", toolAskMessage.ts, sessionId)
		await this.options.postStateToWebview(sessionId || undefined)

		// A session's agent awaits its ask, so a second pending for the same session means the
		// first can never be answered — settle it as denied rather than leak a hung promise.
		this.settleOrphanedPendings(sessionId, "Superseded by a newer ask in the same session")

		return new Promise<{ approved: boolean; reason?: string }>((resolve) => {
			this.pendingToolApprovals.set(sessionId, {
				resolve,
				toolCallId: request.toolCallId,
				messageTs: toolAskMessage.ts,
				toolName: request.toolName,
			})
		})
	}

	async handleAskQuestion(question: string, options: string[], context: AskIdentity): Promise<string> {
		const sessionId = this.askSessionId(context ?? {})
		const askData: ClineAskQuestion = {
			question,
			options: options?.length ? options : undefined,
		}
		const askMessage: ClineMessage = {
			ts: this.nextMessageTs(),
			type: "ask",
			ask: "followup",
			text: JSON.stringify(askData),
			partial: false,
		}

		this.options.messages.appendAndEmit([askMessage], {
			type: "status",
			payload: { sessionId, status: "running" },
		})
		this.options.setTurnPhase?.("awaiting_followup", askMessage.ts, sessionId)
		await this.options.postStateToWebview(sessionId || undefined)

		this.settleOrphanedPendings(sessionId, "Superseded by a newer ask in the same session")

		return new Promise<string>((resolve) => {
			this.pendingAskResolves.set(sessionId, resolve)
		})
	}

	/**
	 * Resolve `sessionId`'s pending tool approval, if it has one. A response for a session with
	 * no pending returns false and touches nothing — most importantly, it never resolves ANOTHER
	 * session's pending.
	 */
	resolvePendingToolApproval(
		sessionId: string | undefined,
		prompt: string | undefined,
		responseType: ClineAskResponse | undefined,
		images?: string[],
		files?: string[],
	): boolean {
		const key = sessionId?.trim()
		if (!key) {
			return false
		}
		const pending = this.pendingToolApprovals.get(key)
		if (!pending) {
			return false
		}

		if (responseType === "messageResponse") {
			Logger.log("[SdkController] Leaving pending tool approval open and routing user message as queued follow-up")
			this.options.setTurnPhase?.("awaiting_approval", pending.messageTs, key)
			// The approval remains pending. The chat message still needs normal follow-up routing.
			return false
		}

		this.pendingToolApprovals.delete(key)

		const approved = responseType === "yesButtonClicked"
		Logger.log(`[SdkController] Resolving pending tool approval: approved=${approved} (responseType=${responseType})`)
		if (approved) {
			this.options.recordApprovedToolMessage?.(pending.toolCallId, pending.messageTs)
		}

		// Approved or rejected by approval controls, the agent resumes its turn and returns to streaming.
		// On rejection the agent receives the denial and continues; the SDK drives the next phase.
		this.options.setTurnPhase?.("streaming", undefined, key)
		// The reason must state the operation did NOT happen (for edits: the file is
		// unchanged) — raw feedback alone reads like iteration on an applied change.
		const denialReason = buildToolApprovalDenialReason(pending.toolName, prompt)
		if (!approved && (prompt?.trim() || images?.length || files?.length)) {
			const userMessage: ClineMessage = {
				ts: this.nextMessageTs(),
				type: "say",
				say: "user_feedback",
				text: prompt ?? "",
				images,
				files,
				partial: false,
			}
			this.options.messages.appendAndEmit([userMessage], {
				type: "status",
				payload: { sessionId: key, status: "running" },
			})
		}
		if (!approved) {
			this.options.recordDeniedToolApproval?.(pending.toolCallId, pending.toolName, denialReason)
		}
		pending.resolve({
			approved,
			...(approved ? {} : { reason: denialReason }),
		})
		return true
	}

	/**
	 * Resolve `sessionId`'s pending follow-up question, if it has one. Same contract as
	 * {@link resolvePendingToolApproval}: no pending for THAT session = false, nothing touched.
	 */
	resolvePendingAskQuestion(sessionId: string | undefined, prompt: string | undefined): boolean {
		const key = sessionId?.trim()
		if (!key) {
			return false
		}
		const resolve = this.pendingAskResolves.get(key)
		if (!resolve) {
			return false
		}

		this.pendingAskResolves.delete(key)
		const responseText = prompt ?? ""
		Logger.log(`[SdkController] Resolving pending ask_question with: "${responseText.substring(0, 80)}"`)

		if (responseText) {
			const userMessage: ClineMessage = {
				ts: this.nextMessageTs(),
				type: "say",
				say: "user_feedback",
				text: responseText,
				partial: false,
			}
			this.options.messages.appendAndEmit([userMessage], {
				type: "status",
				payload: { sessionId: key, status: "running" },
			})
		}

		// User answered the follow-up — the agent resumes its turn.
		this.options.setTurnPhase?.("streaming", undefined, key)
		resolve(responseText)
		return true
	}

	/** True when `sessionId` has a pending ask or tool approval. Used by tests and diagnostics. */
	hasPendingFor(sessionId: string): boolean {
		return this.pendingAskResolves.has(sessionId) || this.pendingToolApprovals.has(sessionId)
	}

	/**
	 * Clear ONE session's pendings — the session being cancelled, cleared, or torn down. Every
	 * other chat's pendings stay live; a session-blind clear here is how opening one chat used to
	 * silently answer another chat's question.
	 */
	clearPending(reason: string, sessionId: string): void {
		const key = sessionId?.trim()
		if (!key) {
			return
		}
		this.settlePendingsFor(key, reason)
	}

	/** Clear EVERY session's pendings — controller disposal only. */
	clearAllPending(reason: string): void {
		for (const key of [...this.pendingAskResolves.keys(), ...this.pendingToolApprovals.keys()]) {
			this.settlePendingsFor(key, reason)
		}
	}

	private settleOrphanedPendings(sessionId: string, reason: string): void {
		if (this.hasPendingFor(sessionId)) {
			Logger.warn(`[SdkController] Session ${sessionId} already had a pending interaction; settling it: ${reason}`)
			this.settlePendingsFor(sessionId, reason)
		}
	}

	private settlePendingsFor(sessionId: string, reason: string): void {
		const resolveAsk = this.pendingAskResolves.get(sessionId)
		this.pendingAskResolves.delete(sessionId)
		// ask_question is awaiting this promise inside the outgoing agent run. Settle it
		// before session teardown so the run can unwind instead of remaining suspended;
		// use an empty answer so the lifecycle reason is not presented as user input.
		resolveAsk?.("")

		const pending = this.pendingToolApprovals.get(sessionId)
		this.pendingToolApprovals.delete(sessionId)
		if (pending) {
			// Record before resolving: the denial unblocks the core, which emits the
			// tool's lifecycle events before the caller's abort lands. Unless the
			// denial is already recorded, the translator renders those events as a
			// second tool row next to the still-visible approval ask.
			this.options.recordDeniedToolApproval?.(pending.toolCallId, pending.toolName, reason)
			pending.resolve({ approved: false, reason })
		}
	}

	/**
	 * Mint a unique message id from the SHARED minter so interaction messages (tool-approval
	 * asks, ask_question, user_feedback) never collide with translator-minted ids. Falls back to
	 * a private minter when none is wired (tests).
	 */
	private nextMessageTs(): number {
		return this.getMinter().nextId()
	}

	private fallbackMinter: MessageIdMinter | undefined
	private getMinter(): MessageIdMinter {
		if (this.options.getMinter) {
			return this.options.getMinter()
		}
		if (!this.fallbackMinter) {
			// Lazy import-free fallback: construct on first use.
			this.fallbackMinter = new MessageIdMinter()
		}
		return this.fallbackMinter
	}
}
