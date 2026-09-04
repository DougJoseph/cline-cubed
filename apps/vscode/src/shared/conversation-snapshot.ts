import type { ExtensionState } from "./ExtensionMessage"
import type { HistoryItem } from "./HistoryItem"

/**
 * Cline Cubed: a chat's conversation has THREE states, and every snapshot must say which one
 * it is speaking for (plan: Docs/2026-08-31_7.49pm_conversation-has-three-states-and-closes-
 * are-facts-not-guesses.md, Part A):
 *
 *   - "conversation"          — the conversation is IN the snapshot (`clineMessages` present):
 *                               authoritative, render it.
 *   - "conversation-loading"  — the chat is real and a load for it is in flight: the snapshot
 *                               carries the chat's identity and `conversationLoading: true`,
 *                               and OMITS the conversation fields. Show the chat's name and a
 *                               loading indication — never the Home screen.
 *   - "settings-only"         — no conversation fields and no loading flag: a settings-level
 *                               update; the surface keeps whatever it is displaying.
 *
 * Before this existed the protocol was two-valued, and a named chat whose conversation was
 * not in memory was answered with a FABRICATED empty conversation — which renders as the Home
 * screen. On a large chat (1,558 messages ≈ 3.9s to load, Doug's logs, 2026-08-31) every
 * reload lost that race; small test chats load in milliseconds, which is why no test ever saw
 * it.
 */

/**
 * Conversation-scoped fields, OMITTED rather than emptied. Deleting the keys (rather than
 * sending empty ones) is what lets a receiving surface leave what it is displaying alone —
 * the wire contract is field PRESENCE (`Object.hasOwn`), not field value.
 */
export const CONVERSATION_FIELDS = [
	"clineMessages",
	"currentTaskItem",
	"activeTaskId",
	"turnState",
	"queuedPrompts",
	"checkpointRestoreInput",
] as const

export type ConversationSnapshotKind = "conversation" | "conversation-loading" | "settings-only"

/** Which of the three forms a received snapshot is — the receiving side of the contract. */
export function conversationSnapshotKind(data: object): ConversationSnapshotKind {
	if (Object.hasOwn(data, "clineMessages")) {
		return "conversation"
	}
	if ((data as { conversationLoading?: unknown }).conversationLoading === true) {
		return "conversation-loading"
	}
	return "settings-only"
}

/**
 * The building side of the contract: shape a snapshot for a NAMED session by residency.
 *
 * - resident → the snapshot already carries the conversation; returned untouched.
 * - not resident, RESTORING → conversation fields stripped; `conversationLoading: true`; the
 *   chat's identity (`activeTaskId`, and `currentTaskItem` when history has it) attached so
 *   the surface can show WHICH chat it is waiting for.
 * - not resident, not restoring → conversation fields stripped, nothing added: the
 *   leave-alone form. A named session is NEVER answered with a fabricated empty conversation.
 *
 * No session named (a focused/identity-less build) → returned untouched; those consumers are
 * outside the per-surface model.
 */
export function applyConversationResidency(
	snapshot: ExtensionState,
	opts: { sessionId?: string; resident: boolean; restoring: boolean; historyItem?: HistoryItem },
): ExtensionState {
	if (!opts.sessionId || opts.resident) {
		return snapshot
	}
	const stripped = snapshot as unknown as Record<string, unknown>
	for (const field of CONVERSATION_FIELDS) {
		delete stripped[field]
	}
	if (opts.restoring) {
		snapshot.conversationLoading = true
		snapshot.activeTaskId = opts.sessionId
		if (opts.historyItem) {
			snapshot.currentTaskItem = opts.historyItem
		}
	}
	return snapshot
}
