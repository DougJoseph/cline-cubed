export type HistoryItem = {
	id: string
	ulid?: string // ULID for better tracking and metrics
	ts: number
	task: string
	tokensIn: number
	tokensOut: number
	cacheWrites?: number
	cacheReads?: number
	totalCost: number

	size?: number
	cwdOnTaskInitialization?: string
	conversationHistoryDeletedRange?: [number, number]
	isFavorited?: boolean

	modelId?: string
	isLegacy?: boolean

	/**
	 * Cline Cubed: the chat's own name, set by renaming it.
	 *
	 * Undefined/blank means the chat has never been renamed, and it is displayed by `task` — its
	 * first prompt. It is a SEPARATE field on purpose: renaming a chat must never rewrite what the
	 * person actually typed. Clearing it restores the first prompt as the displayed name.
	 *
	 * Stored as the `customTitle` session-metadata key. Note the neighbouring `title` metadata key
	 * is NOT this: that one is written from `item.task` on every history write (see
	 * `historyItemToSessionMetadata`), alongside the record's `prompt` and `title` columns, so all
	 * three carry the first prompt and none of them can hold a name of its own.
	 */
	title?: string
}

/**
 * Cline Cubed: the ONE way a chat gets a displayed name. Anywhere a chat is labelled — history
 * rows, the home's recent list, the chats list, the header at the top of an open chat, an editor
 * tab — goes through this, or a renamed chat shows its new name in some places and its first
 * prompt in others.
 */
export function chatDisplayTitle(item: { title?: string; task?: string }): string {
	const named = item.title?.trim()
	return named && named.length > 0 ? named : (item.task ?? "")
}
