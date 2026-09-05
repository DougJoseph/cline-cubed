import { existsSync } from "node:fs"
import path from "node:path"
import type { ClineCoreListHistoryOptions, SessionHistoryRecord } from "@cline/core"
import type { MessageWithMetadata as SdkMessage } from "@cline/llms"
import { formatDisplayUserInput, parseUserInputMode } from "@cline/shared"
import { resolveSessionDataDir } from "@cline/shared/storage"
import { notifyChatTitleChanged } from "@core/controller/chat-surfaces"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import getFolderSize from "get-folder-size"
import type { McpHub } from "@/services/mcp/McpHub"
import type { TelemetryService } from "@/services/telemetry/TelemetryService"
import { Logger } from "@/shared/services/Logger"
import { deleteLegacyTask, readApiConversationHistory, readTaskHistory, readUiMessages, taskDirPath } from "./legacy-state-reader"
import {
	appendLegacyResumeWarning,
	legacyApiHistoryToSdkMessages,
	mergeLegacyUiMessagesWithResumedSdkMessages,
} from "./legacy-task-handling"
import type { MessageIdMinter } from "./message-id-minter"
import { sdkMessagesToClineMessages } from "./message-translator"
import type { SdkSessionLifecycle } from "./sdk-session-lifecycle"
import type { VscodeSessionHost } from "./vscode-session-host"

export interface TaskUsage {
	tokensIn: number
	tokensOut: number
	totalCost?: number
	cacheReads?: number
	cacheWrites?: number
}

export interface SdkTaskHistoryOptions {
	mcpHub: McpHub
	sessions: SdkSessionLifecycle
	/**
	 * VS Code's legacy global storage root. Pre-SDK VS Code tasks lived here under
	 * state/taskHistory.json and tasks/<id>/ instead of ~/.cline/data.
	 */
	legacyExtensionStorageDir?: string
	/**
	 * The process-wide id/seq/epoch authority. When provided, history rendering mints ids from
	 * it so regenerated history ids never overlap live-session ids. Optional for tests.
	 */
	getMinter?: () => MessageIdMinter
	telemetry?: TelemetryService
}

type SdkTaskHistoryListOptions = ClineCoreListHistoryOptions & {
	offset?: number
}

/**
 * Cline Cubed: how a rename's write is retried when the host reports it did not land — see
 * `setTaskTitle`. Five tries over about half a second comfortably outlasts a turn's end-of-turn
 * burst of row writes, which is the one thing known to reject it.
 */
const RENAME_WRITE_ATTEMPTS = 5
const RENAME_WRITE_RETRY_DELAY_MS = 100

function metadataNumber(metadata: SessionHistoryRecord["metadata"] | undefined, key: string): number | undefined {
	const value = metadata?.[key]
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function metadataBoolean(metadata: SessionHistoryRecord["metadata"] | undefined, key: string): boolean | undefined {
	const value = metadata?.[key]
	return typeof value === "boolean" ? value : undefined
}

function metadataString(metadata: SessionHistoryRecord["metadata"] | undefined, key: string): string | undefined {
	const value = metadata?.[key]
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function dateStringToTimestamp(value: string | null | undefined): number {
	if (!value) {
		return 0
	}
	const timestamp = Date.parse(value)
	return Number.isFinite(timestamp) ? timestamp : 0
}

/**
 * Sort comparator for session history records by recency: newest first.
 *
 * Falls back through `updatedAt` → `endedAt` → `startedAt` so records that
 * haven't been touched since creation still sort deterministically. Used both
 * when merging the initial list and when re-sorting after a single-record
 * patch, so the two orderings can never diverge.
 */
function compareSessionHistoryRecordsByRecencyDesc(a: SessionHistoryRecord, b: SessionHistoryRecord): number {
	return (
		dateStringToTimestamp(b.updatedAt ?? b.endedAt ?? b.startedAt) -
		dateStringToTimestamp(a.updatedAt ?? a.endedAt ?? a.startedAt)
	)
}

export function historyItemToSessionMetadata(item: HistoryItem, fallbackModelId?: string): Record<string, unknown> {
	return {
		title: item.task,
		isFavorited: item.isFavorited ?? false,
		size: item.size ?? 0,
		totalCost: item.totalCost ?? 0,
		tokensIn: item.tokensIn ?? 0,
		tokensOut: item.tokensOut ?? 0,
		cacheWrites: item.cacheWrites ?? 0,
		cacheReads: item.cacheReads ?? 0,
		modelId: item.modelId ?? fallbackModelId ?? "",
		legacyTask: item.isLegacy ?? false,
	}
}

function historyItemToSessionHistoryRecord(item: HistoryItem): SessionHistoryRecord {
	const startedAt = new Date(item.ts || Date.now()).toISOString()
	const displayTask = formatDisplayUserInput(item.task)
	return {
		sessionId: item.id,
		source: "vscode",
		pid: 0,
		startedAt,
		endedAt: startedAt,
		exitCode: 0,
		status: "completed",
		interactive: true,
		provider: "",
		model: item.modelId ?? "",
		cwd: item.cwdOnTaskInitialization ?? "",
		workspaceRoot: item.cwdOnTaskInitialization ?? "",
		enableTools: true,
		enableSpawn: false,
		enableTeams: false,
		isSubagent: false,
		prompt: displayTask,
		metadata: {
			...historyItemToSessionMetadata({ ...item, task: displayTask }),
			legacyTask: true,
		},
		updatedAt: startedAt,
	}
}

/** SdkMessage plus the plan/act mode recovered from its <user_input mode="..."> wrapper. */
type SdkDisplayMessage = SdkMessage & { uiMode?: "plan" | "act" | "yolo" }

function parseUserMessageMode(content: SdkMessage["content"]): "plan" | "act" | "yolo" | undefined {
	if (typeof content === "string") {
		return parseUserInputMode(content)
	}
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			const mode = parseUserInputMode(block.text)
			if (mode) {
				return mode
			}
		}
	}
	return undefined
}

function sanitizeSdkUserMessagesForDisplay(messages: SdkMessage[]): SdkDisplayMessage[] {
	return messages.map((message): SdkDisplayMessage => {
		if (message.role !== "user") {
			return message
		}
		// Recover the mode BEFORE display sanitization strips the <user_input mode="..."> wrapper;
		// history rendering uses it to style each turn's inferred completion row.
		const uiMode = parseUserMessageMode(message.content)
		if (typeof message.content === "string") {
			return { ...message, content: formatDisplayUserInput(message.content), uiMode }
		}
		if (Array.isArray(message.content)) {
			return {
				...message,
				content: message.content.map((block) =>
					block.type === "text" && typeof block.text === "string"
						? { ...block, text: formatDisplayUserInput(block.text) }
						: block,
				),
				uiMode,
			}
		}
		return message
	})
}

export function sessionHistoryRecordToHistoryItem(item: SessionHistoryRecord): HistoryItem {
	const metadata = item.metadata
	return {
		id: item.sessionId,
		ts: dateStringToTimestamp(item.updatedAt ?? item.endedAt ?? item.startedAt),
		task: formatDisplayUserInput(metadataString(metadata, "title") ?? item.prompt ?? ""),
		tokensIn: metadataNumber(metadata, "tokensIn") ?? 0,
		tokensOut: metadataNumber(metadata, "tokensOut") ?? 0,
		cacheWrites: metadataNumber(metadata, "cacheWrites") ?? 0,
		cacheReads: metadataNumber(metadata, "cacheReads") ?? 0,
		totalCost: metadataNumber(metadata, "totalCost") ?? 0,
		size: metadataNumber(metadata, "size"),
		isFavorited: metadataBoolean(metadata, "isFavorited") ?? metadataBoolean(metadata, "is_favorited") ?? false,
		modelId: item.model || metadataString(metadata, "modelId") || "",
		cwdOnTaskInitialization: item.cwd ?? item.workspaceRoot,
		isLegacy:
			metadataBoolean(metadata, "legacyTask") === true || metadataBoolean(metadata, "migratedFromLegacyTask") === true,
		// Cline Cubed: the chat's own name, if it has been renamed. Deliberately NOT the "title"
		// metadata key above — that one is written from `item.task` on every history write and so
		// only ever carries the first prompt.
		title: metadataString(metadata, "customTitle"),
	}
}

export class SdkTaskHistory {
	private cachedHistoryHost?: VscodeSessionHost
	private cachedHistoryHostPromise?: Promise<VscodeSessionHost>
	private cachedHistoryHostRefCount = 0
	private cachedHistoryHostIdleTimer?: NodeJS.Timeout
	private metadataHistoryCache?: {
		records: SessionHistoryRecord[]
		hostLimit: number
		createdAt: number
	}
	private disposed = false
	private readonly cachedHistoryHostIdleMs = 30_000
	private readonly metadataHistoryCacheTtlMs = 10_000

	constructor(private readonly options: SdkTaskHistoryOptions) {}

	private getLegacyDataDirs(): (string | undefined)[] {
		const dirs: (string | undefined)[] = [undefined]
		const extensionStorageDir = this.options.legacyExtensionStorageDir?.trim()
		if (extensionStorageDir) {
			dirs.push(extensionStorageDir)
		}
		return dirs
	}

	private readAllLegacyTaskHistory(): {
		item: HistoryItem
		dataDir?: string
	}[] {
		const seenIds = new Set<string>()
		const tasks: { item: HistoryItem; dataDir?: string }[] = []
		for (const dataDir of this.getLegacyDataDirs()) {
			for (const item of readTaskHistory(dataDir)) {
				if (!item.id || seenIds.has(item.id)) {
					continue
				}
				seenIds.add(item.id)
				tasks.push({ item, dataDir })
			}
		}
		return tasks
	}

	private findLegacyTask(taskId: string): { item: HistoryItem; dataDir?: string } | undefined {
		return this.readAllLegacyTaskHistory().find(({ item }) => item.id === taskId)
	}

	private getActiveHistoryHost(): VscodeSessionHost | undefined {
		const sdkHost = this.options.sessions.getActiveSession()?.sdkHost
		if (sdkHost && "listHistory" in sdkHost) {
			return sdkHost as VscodeSessionHost
		}
		return undefined
	}

	private async getCachedHistoryHost(): Promise<VscodeSessionHost> {
		if (this.disposed) {
			throw new Error("SdkTaskHistory has been disposed")
		}

		if (this.cachedHistoryHostIdleTimer) {
			clearTimeout(this.cachedHistoryHostIdleTimer)
			this.cachedHistoryHostIdleTimer = undefined
		}

		if (this.cachedHistoryHost) {
			return this.cachedHistoryHost
		}
		if (this.cachedHistoryHostPromise) {
			return this.cachedHistoryHostPromise
		}

		this.cachedHistoryHostPromise = (async () => {
			const { VscodeSessionHost } = await import("./vscode-session-host")
			const historyHost = await VscodeSessionHost.create({
				mcpHub: this.options.mcpHub,
			})
			this.cachedHistoryHost = historyHost
			return historyHost
		})()

		try {
			return await this.cachedHistoryHostPromise
		} catch (error) {
			this.cachedHistoryHost = undefined
			throw error
		} finally {
			this.cachedHistoryHostPromise = undefined
		}
	}

	private scheduleCachedHistoryHostDispose(): void {
		if (this.disposed || this.cachedHistoryHostRefCount > 0 || !this.cachedHistoryHost) {
			return
		}

		this.cachedHistoryHostIdleTimer = setTimeout(() => {
			void this.disposeCachedHistoryHost("idle")
		}, this.cachedHistoryHostIdleMs)
		this.cachedHistoryHostIdleTimer.unref?.()
	}

	private async disposeCachedHistoryHost(reason: string): Promise<void> {
		if (this.cachedHistoryHostIdleTimer) {
			clearTimeout(this.cachedHistoryHostIdleTimer)
			this.cachedHistoryHostIdleTimer = undefined
		}

		if (this.cachedHistoryHostRefCount > 0) {
			return
		}

		const historyHost = this.cachedHistoryHost
		this.cachedHistoryHost = undefined
		if (!historyHost) {
			return
		}

		await historyHost.dispose(`taskHistory:${reason}`).catch((error) => {
			Logger.warn("[SdkTaskHistory] Failed to dispose cached history host:", error)
		})
	}

	async dispose(): Promise<void> {
		this.disposed = true
		this.invalidateMetadataHistoryCache()
		if (this.cachedHistoryHostPromise) {
			await this.cachedHistoryHostPromise.catch(() => undefined)
		}
		await this.disposeCachedHistoryHost("controllerDispose")
	}

	private invalidateMetadataHistoryCache(): void {
		this.metadataHistoryCache = undefined
	}

	/**
	 * Mirror a persistence-layer write into the cache so the next read sees
	 * the updated record without a full re-enumeration.
	 *
	 * The persistence layer bumps `updatedAt` on every write, so the cached
	 * record is updated to match and the cache is re-sorted to preserve the
	 * descending-`updatedAt` ordering that {@link listHistory} establishes.
	 * When the session isn't in the cache (e.g. a brand-new task whose list
	 * membership/ordering may change) the cache is invalidated so the next
	 * read re-enumerates from disk.
	 */
	private updateCachedSessionRecord(
		sessionId: string,
		updates: { prompt: string; metadata: Record<string, unknown>; updatedAt?: string },
	): void {
		const cache = this.metadataHistoryCache
		if (!cache) {
			return
		}
		const index = cache.records.findIndex((record) => record.sessionId === sessionId)
		if (index === -1) {
			this.invalidateMetadataHistoryCache()
			return
		}
		const existing = cache.records[index]
		cache.records[index] = {
			...existing,
			prompt: updates.prompt,
			// The store merged this write onto what it held; the cache mirrors that, or a name the
			// write did not mention would vanish from the list until the cache expired.
			metadata: { ...(existing.metadata ?? {}), ...updates.metadata },
			// Absent means the write deliberately left the date alone, so the record keeps its own.
			updatedAt: updates.updatedAt ?? existing.updatedAt,
		}
		cache.records.sort(compareSessionHistoryRecordsByRecencyDesc)
	}

	private canUseMetadataHistoryCache(options: SdkTaskHistoryListOptions): boolean {
		return options.hydrate === false
	}

	private async withHistoryHost<T>(fn: (host: VscodeSessionHost) => Promise<T>): Promise<T> {
		const activeHistoryHost = this.getActiveHistoryHost()
		if (activeHistoryHost) {
			return fn(activeHistoryHost)
		}

		const historyHost = await this.getCachedHistoryHost()
		this.cachedHistoryHostRefCount += 1
		try {
			return await fn(historyHost)
		} finally {
			this.cachedHistoryHostRefCount = Math.max(0, this.cachedHistoryHostRefCount - 1)
			this.scheduleCachedHistoryHostDispose()
		}
	}

	async listHistory(options: SdkTaskHistoryListOptions = {}): Promise<SessionHistoryRecord[]> {
		const offset = Math.max(0, Math.floor(options.offset ?? 0))
		const limit = Math.max(0, Math.floor(options.limit ?? 10_000))
		const hostLimit = offset + limit
		const useCache = this.canUseMetadataHistoryCache(options)
		const now = Date.now()
		const cached = useCache ? this.metadataHistoryCache : undefined
		if (cached && cached.hostLimit >= hostLimit && now - cached.createdAt < this.metadataHistoryCacheTtlMs) {
			const result = cached.records.slice(offset, offset + limit)
			return result
		}

		const hostOptions: ClineCoreListHistoryOptions = { ...options }
		delete (hostOptions as { offset?: number }).offset

		const sdkHistory = await this.withHistoryHost((host) =>
			host.listHistory({
				...hostOptions,
				limit: hostLimit || 10_000,
				includeManifestFallback: true,
			}),
		)
		const visibleSdkHistory = sdkHistory.filter((item) => item.isSubagent !== true)
		const sdkIds = new Set(visibleSdkHistory.map((item) => item.sessionId))
		const legacyHistory = this.readAllLegacyTaskHistory()
			.filter(({ item }) => item.task && !sdkIds.has(item.id))
			.map(({ item }) => historyItemToSessionHistoryRecord(item))
		// An SDK record with legacy metadata is a legacy task that was resumed,
		// i.e. migrated (historyItemToSessionMetadata stamps legacyTask on resume).
		const migratedSdkTaskCount = visibleSdkHistory.filter(
			(item) =>
				metadataBoolean(item.metadata, "migratedFromLegacyTask") === true ||
				metadataBoolean(item.metadata, "legacyTask") === true,
		).length

		const mergedHistory = [...visibleSdkHistory, ...legacyHistory].sort(compareSessionHistoryRecordsByRecencyDesc)
		if (useCache) {
			this.metadataHistoryCache = {
				records: mergedHistory,
				hostLimit,
				createdAt: Date.now(),
			}
		}

		this.options.telemetry?.safeCapture(
			() =>
				this.options.telemetry?.captureLegacyTaskMigrationBacklog({
					pendingLegacyTaskCount: legacyHistory.length,
					migratedSdkTaskCount,
					visibleSdkTaskCount: visibleSdkHistory.length,
					visibleTaskCount: mergedHistory.length,
				}),
			"SdkTaskHistory.listHistory.legacyMigrationBacklog",
		)

		const result = mergedHistory.slice(offset, offset + limit)
		return result
	}

	private async getSdkRecord(taskId: string): Promise<SessionHistoryRecord | undefined> {
		return this.withHistoryHost((host) => host.get(taskId) as Promise<SessionHistoryRecord | undefined>)
	}

	async getClineMessages(taskId: string): Promise<ClineMessage[]> {
		const sdkRecord = await this.getSdkRecord(taskId)
		const legacyTask = this.findLegacyTask(taskId)
		if (!sdkRecord && legacyTask) {
			return readUiMessages(taskId, legacyTask.dataDir)
		}

		const sdkMessages = await this.withHistoryHost((host) => host.readMessages(taskId) as Promise<SdkMessage[]>)
		const clineMessages = sdkMessagesToClineMessages(
			sanitizeSdkUserMessagesForDisplay(sdkMessages),
			this.options.getMinter?.(),
			{
				// Only retag the transcript's terminal text as an inferred completion when the
				// session record says its last turn ended cleanly — status "completed", written
				// by the SDK runtime host's resolveInteractiveStopStatus when the session is
				// released (task switch, clear, extension dispose). Everything else stays a
				// plain text row: "failed"/"cancelled" runs ended on a dangling response, and
				// non-terminal statuses at rest ("idle"/"running"/"pending") mean the process
				// died without recording an outcome — "idle" in particular is also the state
				// after an aborted turn (markTurnIdle runs for every finish reason), so it
				// cannot be trusted as a clean ending. A missing record is likewise an unknown
				// outcome, so it gets no completion styling either.
				finalTurnCompleted: sdkRecord?.status === "completed",
				// Relativize the absolute tool paths for display, same as the live path.
				cwd: sdkRecord?.cwd || sdkRecord?.workspaceRoot || undefined,
			},
		)
		if (sdkRecord && legacyTask) {
			return mergeLegacyUiMessagesWithResumedSdkMessages(readUiMessages(taskId, legacyTask.dataDir), clineMessages)
		}
		return clineMessages
	}

	/**
	 * Absolute path of the directory holding the task's on-disk artifacts: the SDK
	 * session folder (manifest json + messages json) for SDK tasks, or the legacy
	 * tasks/<id> folder for pre-SDK tasks. Undefined when the task is unknown.
	 */
	async getTaskDirPath(taskId: string): Promise<string | undefined> {
		const sdkRecord = await this.getSdkRecord(taskId)
		if (sdkRecord) {
			const messagesPath = typeof sdkRecord.messagesPath === "string" ? sdkRecord.messagesPath.trim() : ""
			if (messagesPath) {
				return path.dirname(messagesPath)
			}
			// Older records may lack messagesPath; fall back to the canonical
			// session directory when it exists on disk.
			const sessionDir = path.join(resolveSessionDataDir(), taskId)
			if (existsSync(sessionDir)) {
				return sessionDir
			}
		}
		return this.getLegacyTaskDirPath(taskId)
	}

	getLegacyTaskDirPath(taskId: string): string | undefined {
		const legacyTask = this.findLegacyTask(taskId)
		return legacyTask ? taskDirPath(taskId, legacyTask.dataDir) : undefined
	}

	/**
	 * The persisted session status ("completed" | "cancelled" | "failed" | ...).
	 * Persisted messages cannot distinguish a completed conversation from one
	 * interrupted mid-stream (both just end with assistant text), so reopening a
	 * task from History uses this status to decide between the Resume Task and
	 * Start New Task affordances.
	 */
	async getSessionStatus(taskId: string): Promise<SessionHistoryRecord["status"] | undefined> {
		const sdkRecord = await this.getSdkRecord(taskId).catch(() => undefined)
		return sdkRecord?.status
	}

	async isLegacyTask(taskId: string): Promise<boolean> {
		const sdkRecord = await this.getSdkRecord(taskId)
		if (sdkRecord) {
			return (
				metadataBoolean(sdkRecord.metadata, "legacyTask") === true ||
				metadataBoolean(sdkRecord.metadata, "migratedFromLegacyTask") === true
			)
		}

		return this.findLegacyTask(taskId) !== undefined
	}

	async getLegacyResumeInitialMessages(taskId: string, fallbackMessages?: unknown[]): Promise<unknown[] | undefined> {
		const sdkRecord = await this.getSdkRecord(taskId)
		const legacyTask = sdkRecord ? undefined : this.findLegacyTask(taskId)
		if (legacyTask) {
			const legacyApiHistory = readApiConversationHistory(taskId, legacyTask.dataDir)
			if (legacyApiHistory.length > 0) {
				return legacyApiHistoryToSdkMessages(legacyApiHistory, legacyTask.item)
			}
		}

		if (!fallbackMessages) {
			return undefined
		}
		return appendLegacyResumeWarning(fallbackMessages as { role: string; content: unknown }[])
	}

	/**
	 * Cline Cubed: `notUse` marks a write as bookkeeping ABOUT the chat rather than work IN it —
	 * favouriting is the one such caller today. The chat's last-used date is then left alone, so the
	 * write does not send the chat to the top of a list ordered by that date.
	 */
	private async updateSession(sessionId: string, item: HistoryItem, notUse = false): Promise<void> {
		const { metadata: writtenMetadata, updated } = await this.withHistoryHost(async (host) => {
			const existing = await host.get(sessionId)
			// ONLY the keys this writer owns. The store MERGES a write onto what is stored, so
			// every other key survives on its own — and `existing.metadata` must NOT be spread in:
			// for a LIVE chat `host.get` answers from the SDK's in-memory copy, which does not learn
			// of this extension's writes (a rename, a generated name) until the SDK's next metadata
			// write, so spreading it re-sent a STALE `customTitle` over the one on the row. Proven
			// in the debug harness 2026-09-04: a typed rename was replaced by the earlier generated
			// name the moment the chat's next turn ended.
			const metadata: Record<string, unknown> = historyItemToSessionMetadata(item, existing?.model)
			if (item.size === undefined) {
				// Not known by this write; the stored value, if any, stays as it is.
				delete metadata.size
			}
			const result = await host.update(sessionId, {
				prompt: item.task,
				metadata,
				title: item.task,
				preserveUpdatedAt: notUse,
			})
			return { metadata, updated: result.updated }
		})
		if (!updated) {
			// The write didn't land (e.g. the session was deleted, or an optimistic-
			// concurrency retry was exhausted by a racing writer). Patching the cache
			// here would show a fake "updated" record until the TTL expires, so
			// invalidate instead and let the next read re-enumerate from disk.
			this.invalidateMetadataHistoryCache()
			return
		}
		// The persistence adapter stamps `updatedAt` with the wall-clock write time
		// (see `nowIso()` in file-session-service.ts), not `item.ts`. Mirror that here
		// rather than deriving from `item.ts`: callers like toggleTaskFavorite() reuse
		// an old HistoryItem whose `ts` predates this write, which would otherwise let
		// the cached ordering diverge from what's on disk until the cache TTL expires.
		this.updateCachedSessionRecord(sessionId, {
			prompt: item.task,
			metadata: writtenMetadata,
			// A write that did not stamp the date on disk must not stamp it in the cache either, or
			// the list would reorder until the cache expired and then jump back.
			updatedAt: notUse ? undefined : new Date().toISOString(),
		})
	}

	async updateTaskHistoryItem(item: HistoryItem, notUse = false): Promise<void> {
		await this.updateSession(item.id, item, notUse)
		// Cline Cubed: this is where a brand-new chat first gets a record, and therefore a name —
		// its first prompt. Anything showing that chat outside a webview (an editor tab title)
		// cannot learn the name any earlier, because the webview announces its session from the
		// state post that this call FOLLOWS. Announcing the id is enough; listeners re-resolve.
		notifyChatTitleChanged(item.id)
	}

	/**
	 * Cline Cubed: rename a chat.
	 *
	 * This deliberately does NOT go through `updateSession`. That writer sets `prompt: item.task`
	 * and `title: item.task` on the record and `title` in its metadata — all three from the display
	 * label — so routing a rename through it would overwrite the person's actual first prompt with
	 * the new name, permanently. The name therefore lives in its own `customTitle` metadata key,
	 * written here and nowhere else, and every other history write preserves it by spreading the
	 * existing metadata forward.
	 *
	 * A blank title CLEARS the key, which restores the first prompt as the displayed name.
	 */
	async setTaskTitle(sessionId: string, title: string): Promise<void> {
		const trimmed = title.trim()
		await this.withHistoryHost(async (host) => {
			const existing = await host.get(sessionId)
			if (!existing) {
				// UNGATED: a name was asked for and there is no chat to put it on.
				Logger.warn(`[SdkTaskHistory] Cannot rename, session not found: ${sessionId}`)
				return
			}
			// A session write MERGES the metadata it is given onto what is stored, so clearing a
			// name cannot be done by leaving the key out — it is named for removal instead. Only
			// the key this write means to change is sent; everything else stays as stored.
			const clearing = !trimmed
			// A rename is not use of the chat: it must not move the chat in a list ordered by when
			// each was last used. Doug, 2026-08-31.
			const updates = {
				metadata: clearing ? {} : { customTitle: trimmed },
				removeMetadataKeys: clearing ? ["customTitle"] : undefined,
				preserveUpdatedAt: true,
			}
			// The write is guarded by the row's status lock, and the SDK gives up after four
			// back-to-back attempts. A name that lands while the chat's turn is ending collides
			// with the SDK's own burst of writes (status, usage, status, then the history usage
			// write), each of which bumps that lock — proven in the debug harness, where an
			// instant provider put the generated name inside that burst every time. So a write
			// the host reports as not landed is tried again after a short pause, a few times,
			// and a rename that still did not land is REPORTED rather than dropped in silence.
			for (let attempt = 0; attempt < RENAME_WRITE_ATTEMPTS; attempt++) {
				const result = await host.update(sessionId, updates)
				if (result.updated) {
					return
				}
				await new Promise((resolve) => setTimeout(resolve, RENAME_WRITE_RETRY_DELAY_MS))
			}
			// UNGATED: the name the person (or the naming request) supplied is not on the chat.
			Logger.warn(
				`[SdkTaskHistory] Rename of ${sessionId} did not land after ${RENAME_WRITE_ATTEMPTS} attempts — the chat still shows its previous name`,
			)
		})
		// Renaming is rare, so drop the cache and let the next read re-enumerate from disk rather
		// than patching a record in place. The patch helper rewrites `prompt` as well, which is the
		// one thing a rename must never touch.
		this.invalidateMetadataHistoryCache()
	}

	private async deleteSession(sessionId: string): Promise<void> {
		const legacyTask = this.findLegacyTask(sessionId)
		try {
			await this.withHistoryHost(async (host) => {
				await host.delete(sessionId)
			})
		} catch (error) {
			if (!legacyTask) {
				throw error
			}
			Logger.warn(`[SdkTaskHistory] SDK session missing while deleting legacy task: ${sessionId}`, error)
		}
		if (legacyTask) {
			deleteLegacyTask(sessionId, legacyTask.dataDir)
		}
		this.invalidateMetadataHistoryCache()
	}

	async findHistoryItem(taskId: string): Promise<HistoryItem | undefined> {
		const sdkHistoryItem = await this.withHistoryHost(async (host) => {
			const sdkRecord = await host.get(taskId)
			if (!sdkRecord || sdkRecord.isSubagent === true) {
				return undefined
			}

			const historyItem = sessionHistoryRecordToHistoryItem(sdkRecord as SessionHistoryRecord)
			historyItem.size = await this.getCachedTaskSize(host, sdkRecord as SessionHistoryRecord)
			return historyItem
		})
		if (sdkHistoryItem) {
			return sdkHistoryItem
		}

		const legacyItem = this.findLegacyTask(taskId)?.item
		return legacyItem ? { ...legacyItem, isLegacy: true } : undefined
	}

	/**
	 * Cline Cubed: the chat's record AS STORED — never the live session's in-memory copy.
	 *
	 * `findHistoryItem` goes through the active session's host, and for a LIVE chat the SDK
	 * answers that from memory (`toActiveSessionRecord`), which does not learn of this
	 * extension's own writes until the SDK's next metadata write re-reads the manifest. A name
	 * written to the row mid-run is therefore invisible there. This reads through the history
	 * host instead, which holds no live sessions and so reads the row. Used where the stored
	 * name is the question: the editor tab's label, and the "already named?" guard on a
	 * generated name. Size is not hydrated — a name lookup has no use for it.
	 */
	async findStoredHistoryItem(taskId: string): Promise<HistoryItem | undefined> {
		const historyHost = await this.getCachedHistoryHost()
		this.cachedHistoryHostRefCount += 1
		try {
			const sdkRecord = await historyHost.get(taskId)
			if (sdkRecord && sdkRecord.isSubagent !== true) {
				return sessionHistoryRecordToHistoryItem(sdkRecord as SessionHistoryRecord)
			}
		} finally {
			this.cachedHistoryHostRefCount = Math.max(0, this.cachedHistoryHostRefCount - 1)
			this.scheduleCachedHistoryHostDispose()
		}
		const legacyItem = this.findLegacyTask(taskId)?.item
		return legacyItem ? { ...legacyItem, isLegacy: true } : undefined
	}

	async deleteTaskFromState(id: string): Promise<HistoryItem[]> {
		await this.deleteSession(id)
		return (await this.listHistory()).map(sessionHistoryRecordToHistoryItem)
	}

	async deleteAllTaskHistory(options: { preserveFavorites?: boolean } = {}): Promise<number> {
		const history = await this.listHistory({ hydrate: false })
		const tasksToDelete = options.preserveFavorites
			? history.filter(
					(item) =>
						!(
							metadataBoolean(item.metadata, "isFavorited") ??
							metadataBoolean(item.metadata, "is_favorited") ??
							false
						),
				)
			: history

		let deletedCount = 0
		for (const item of tasksToDelete) {
			try {
				await this.deleteSession(item.sessionId)
				deletedCount += 1
			} catch (error) {
				Logger.error(`[SdkTaskHistory] Failed to delete task history item: ${item.sessionId}`, error)
			}
		}

		return deletedCount
	}

	async updateTaskHistory(item: HistoryItem, notUse = false): Promise<HistoryItem[]> {
		await this.updateTaskHistoryItem(item, notUse)
		return (await this.listHistory()).map(sessionHistoryRecordToHistoryItem)
	}

	async updateTaskUsage(taskId: string | undefined, usage: TaskUsage): Promise<void> {
		Logger.log(
			`[SdkController] Task usage: tokensIn=${usage.tokensIn}, tokensOut=${usage.tokensOut}, cost=${usage.totalCost ?? 0}`,
		)

		if (!taskId) {
			return
		}

		const historyItem = await this.findHistoryItem(taskId)
		if (!historyItem) {
			return
		}

		historyItem.tokensIn = (historyItem.tokensIn || 0) + usage.tokensIn
		historyItem.tokensOut = (historyItem.tokensOut || 0) + usage.tokensOut
		historyItem.cacheReads = (historyItem.cacheReads || 0) + (usage.cacheReads ?? 0)
		historyItem.cacheWrites = (historyItem.cacheWrites || 0) + (usage.cacheWrites ?? 0)
		historyItem.totalCost = (historyItem.totalCost || 0) + (usage.totalCost ?? 0)
		historyItem.ts = Date.now()

		await this.updateTaskHistoryItem(historyItem)
	}

	private async getCachedTaskSize(host: VscodeSessionHost, record: SessionHistoryRecord): Promise<number | undefined> {
		// metadata.size is a display cache: fill it when absent, and let explicit item.size updates replace it.
		const cachedSize = metadataNumber(record.metadata, "size")
		if (cachedSize !== undefined && cachedSize >= 0) {
			return cachedSize
		}

		const artifactSize = await this.getSessionArtifactSize(record)
		if (artifactSize !== undefined) {
			await this.cacheTaskSize(host, record, artifactSize)
			return artifactSize
		}

		return undefined
	}

	private async getSessionArtifactSize(record: SessionHistoryRecord): Promise<number | undefined> {
		const messagesPath = typeof record.messagesPath === "string" ? record.messagesPath.trim() : ""
		if (!messagesPath) {
			return undefined
		}

		try {
			const size = await getFolderSize.loose(path.dirname(messagesPath), {
				bigint: false,
			})
			return Number.isFinite(size) ? size : undefined
		} catch (error) {
			Logger.warn(`[SdkTaskHistory] Failed to calculate SDK session size: ${record.sessionId}`, error)
			return undefined
		}
	}

	private async cacheTaskSize(host: VscodeSessionHost, record: SessionHistoryRecord, size: number): Promise<void> {
		if (!Number.isFinite(size) || size < 0 || metadataNumber(record.metadata, "size") === size) {
			return
		}

		// `size` alone: the store merges, and `record` may be the SDK's stale in-memory copy of a
		// live chat (see `updateSession` above), so nothing else from it may be written back.
		await host.update(record.sessionId, { metadata: { size } })
		this.invalidateMetadataHistoryCache()
	}
}
