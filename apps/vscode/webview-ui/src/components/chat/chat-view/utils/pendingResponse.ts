import type { ClineMessage, TurnState } from "@shared/ExtensionMessage"
import type { PendingResponse, PendingUserMessage } from "../types/chatTypes"

function sameOptimisticMessage(left: ClineMessage, right: ClineMessage): boolean {
	// `left` is a candidate authoritative message from the transcript; `right`
	// is the optimistic bubble (pending.message). Comparisons are directional.
	const leftImages = left.images ?? []
	const rightImages = right.images ?? []
	const leftFiles = left.files ?? []
	const rightFiles = right.files ?? []
	const optimisticSay = right.say === "task" || right.say === "user_feedback"

	if (!(left.type === "say" && right.type === "say" && optimisticSay && left.say === right.say)) {
		return false
	}
	// The image bridge transforms the authoritative echo of a message that
	// carried images: it APPENDS the description block to the text and STRIPS
	// the image bytes (the reasoner gets the text description instead). An
	// exact-text/exact-images comparison therefore never matches, the optimistic
	// bubble is never confirmed/removed, and the chat shows a duplicate message
	// (one with the image, one with the bridge text) in the wrong order.
	// Match when the authoritative text STARTS with the optimistic text (the
	// bridge block is always appended last) and the images were bridged away.
	const textMatches = left.text?.startsWith(right.text ?? "") ?? false
	const imagesBridged = rightImages.length > 0 && leftImages.length === 0
	const imagesMatch =
		leftImages.length === rightImages.length && leftImages.every((image, index) => image === rightImages[index])
	const filesMatch = leftFiles.length === rightFiles.length && leftFiles.every((file, index) => file === rightFiles[index])
	return textMatches && (imagesMatch || imagesBridged) && filesMatch
}

export function hasPendingMessageConfirmation(messages: ClineMessage[], pending: PendingUserMessage): boolean {
	return messages.some((message) => message.ts > pending.afterTs && sameOptimisticMessage(message, pending.message))
}

export function withPendingUserMessage(messages: ClineMessage[], pending: PendingUserMessage | undefined): ClineMessage[] {
	return !pending || hasPendingMessageConfirmation(messages, pending) ? messages : [...messages, pending.message]
}

/**
 * Keep the optimistic loader only until the backend acknowledges this submission.
 * TurnState sequence is authoritative when available; message growth is the legacy fallback.
 */
export function isPendingResponseUnconfirmed(
	pendingResponse: PendingResponse | undefined,
	turnState: TurnState | undefined,
	messageCount: number,
): boolean {
	if (!pendingResponse) {
		return false
	}
	if (turnState) {
		return pendingResponse.turnStateSeq !== undefined && turnState.seq <= pendingResponse.turnStateSeq
	}
	return messageCount <= pendingResponse.messageCount
}
