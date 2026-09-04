import { describe, expect, it } from "vitest"
import { applyConversationResidency, CONVERSATION_FIELDS, conversationSnapshotKind } from "./conversation-snapshot"
import type { ExtensionState } from "./ExtensionMessage"
import type { HistoryItem } from "./HistoryItem"

// The three-answer wire contract for a chat's conversation (plan:
// Docs/2026-08-31_7.49pm_conversation-has-three-states-and-closes-are-facts-not-guesses.md).
// These tests pin the exact behavior whose absence produced the title-then-Home reload bug: a
// named chat whose conversation was not in memory was answered with a FABRICATED empty
// conversation, which renders as the Home screen.

function makeSnapshot(): ExtensionState {
	return {
		clineMessages: [{ ts: 1, type: "say", say: "task", text: "hello" }],
		currentTaskItem: { id: "chat-1", ts: 1, task: "hello" } as HistoryItem,
		activeTaskId: "chat-1",
		turnState: { phase: "idle" },
		queuedPrompts: [],
		checkpointRestoreInput: undefined,
		version: "0.0.0",
	} as unknown as ExtensionState
}

describe("applyConversationResidency — the building side", () => {
	it("answer 1: a RESIDENT session's snapshot is untouched", () => {
		const snapshot = makeSnapshot()
		const result = applyConversationResidency(snapshot, { sessionId: "chat-1", resident: true, restoring: false })
		expect(result.clineMessages).toHaveLength(1)
		expect(result.activeTaskId).toBe("chat-1")
		expect(result.conversationLoading).toBeUndefined()
	})

	it("answer 2: a RESTORING session gets the loading form — identity attached, conversation OMITTED", () => {
		const historyItem = { id: "chat-1", ts: 1, task: "hello", title: "My chat" } as HistoryItem
		const result = applyConversationResidency(makeSnapshot(), {
			sessionId: "chat-1",
			resident: false,
			restoring: true,
			historyItem,
		})
		// The conversation fields are ABSENT (field presence is the wire contract), except the
		// identity the loading form deliberately re-attaches.
		expect(Object.hasOwn(result, "clineMessages")).toBe(false)
		expect(Object.hasOwn(result, "turnState")).toBe(false)
		expect(Object.hasOwn(result, "queuedPrompts")).toBe(false)
		expect(result.conversationLoading).toBe(true)
		expect(result.activeTaskId).toBe("chat-1")
		expect(result.currentTaskItem).toBe(historyItem)
	})

	it("answer 3: an ABSENT session gets the leave-alone form — no fields, no flag, and NEVER a fabricated empty list", () => {
		const result = applyConversationResidency(makeSnapshot(), { sessionId: "chat-1", resident: false, restoring: false })
		for (const field of CONVERSATION_FIELDS) {
			expect(Object.hasOwn(result, field)).toBe(false)
		}
		expect(result.conversationLoading).toBeUndefined()
	})

	it("no session named (focused/identity-less build): untouched", () => {
		const result = applyConversationResidency(makeSnapshot(), { resident: false, restoring: false })
		expect(result.clineMessages).toHaveLength(1)
	})

	it("restoring with NO history item still names the chat", () => {
		const result = applyConversationResidency(makeSnapshot(), { sessionId: "chat-9", resident: false, restoring: true })
		expect(result.conversationLoading).toBe(true)
		expect(result.activeTaskId).toBe("chat-9")
		expect(Object.hasOwn(result, "currentTaskItem")).toBe(false)
	})
})

describe("conversationSnapshotKind — the receiving side", () => {
	it("branch 1: clineMessages present → conversation, even when empty (a real, empty chat is authoritative)", () => {
		expect(conversationSnapshotKind({ clineMessages: [] })).toBe("conversation")
		expect(conversationSnapshotKind({ clineMessages: [{ ts: 1 }] })).toBe("conversation")
	})

	it("branch 2: no clineMessages + conversationLoading true → conversation-loading", () => {
		expect(conversationSnapshotKind({ conversationLoading: true, activeTaskId: "chat-1" })).toBe("conversation-loading")
	})

	it("branch 3: neither → settings-only (keep what you are showing)", () => {
		expect(conversationSnapshotKind({ version: "x" })).toBe("settings-only")
		// A non-true loading value is not a loading form.
		expect(conversationSnapshotKind({ conversationLoading: false })).toBe("settings-only")
	})

	it("a conversation snapshot outranks a stray loading flag (presence of messages is authoritative)", () => {
		expect(conversationSnapshotKind({ clineMessages: [], conversationLoading: true })).toBe("conversation")
	})
})
