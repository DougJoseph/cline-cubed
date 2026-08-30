import { getProviderAuthStorageId } from "@cline/core"
import { createSessionId } from "@cline/shared"
import { CLINE_ACCOUNT_AUTH_ERROR_MESSAGE } from "@shared/ClineAccount"
import type { ClineMessage, TurnPhase } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import type { Settings } from "@shared/storage/state-keys"
import type { Mode } from "@shared/storage/types"
import type { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"
import { isDirectory } from "@/utils/fs"
import { PROVIDER_FAILURE_ERROR_TYPE, PROVIDER_FAILURE_PHASE, type ProviderFailureTelemetry } from "./provider-failure-telemetry"
import type { SdkMessageCoordinator } from "./sdk-message-coordinator"
import type { SdkSessionConfigBuilder } from "./sdk-session-config-builder"
import type { SdkSessionLifecycle } from "./sdk-session-lifecycle"
import { historyItemToSessionMetadata, type SdkTaskHistory } from "./sdk-task-history"
import type { SdkSessionHost } from "./session-host"
import { createTaskProxy, type TaskProxy } from "./task-proxy"
import type { VscodeSessionHost } from "./vscode-session-host"

type StartInput = Parameters<VscodeSessionHost["start"]>[0]
type InitialMessages = StartInput["initialMessages"]
type SessionConfig = Awaited<ReturnType<SdkSessionConfigBuilder["build"]>>

function usesClineAccountAuth(providerId: string): boolean {
	return getProviderAuthStorageId(providerId) === "cline"
}

export interface SdkTaskStartCoordinatorOptions {
	stateManager: StateManager
	sessions: SdkSessionLifecycle
	messages: SdkMessageCoordinator
	taskHistory: SdkTaskHistory
	sessionConfigBuilder: SdkSessionConfigBuilder
	buildStartSessionInput: (
		config: SessionConfig,
		input: {
			prompt?: string
			images?: string[]
			files?: string[]
			historyItem?: HistoryItem
			taskSettings?: Partial<Settings>
			cwd: string
			mode: Mode
		},
	) => StartInput
	createHistoryItemFromSession: (sessionId: string, prompt: string, modelId?: string, cwd?: string) => HistoryItem
	clearTask: (options?: { stopActiveSession?: boolean }) => Promise<void>
	setTask: (task: TaskProxy | undefined) => void
	onAskResponse: (text?: string, images?: string[], files?: string[], sessionId?: string) => Promise<void>
	/** Cline Cubed: `sessionId` names the chat being cancelled — the proxy always passes its own. */
	onCancelTask: (sessionId?: string) => Promise<void>
	getWorkspaceRoot: () => Promise<string>
	createTempSessionHost: () => Promise<SdkSessionHost>
	loadInitialMessages: (reader: SdkSessionHost, taskId: string) => Promise<unknown[] | undefined>
	resolveContextMentions: (text: string) => Promise<string>
	isClineManagedProviderActive: () => boolean
	emitClineAuthError: (task?: string) => void
	captureProviderApiError?: (event: ProviderFailureTelemetry) => void
	postStateToWebview: () => Promise<void>
	/**
	 * Cline Cubed: set the authoritative turn phase for ONE session. A chat's snapshot reads its
	 * OWN session's phase — a write to the focused tracker alone never reaches the webview — so a
	 * new task's "streaming" must be stamped on the session itself, and it must happen the moment
	 * the session id exists, before anything renders. Optional for tests.
	 */
	setTurnPhase?: (phase: TurnPhase, anchorTs?: number, sessionId?: string) => void
	/**
	 * Cline Cubed: a resume was forced onto a NEW SDK session id (the runtime declined the
	 * requested one). Every binding outside this coordinator — the proxies map, the chat-surface
	 * registry — still keys the previous id, so the controller re-keys them here.
	 */
	onSessionIdChanged?: (previousSessionId: string, newSessionId: string, task: TaskProxy) => void
}

export class SdkTaskStartCoordinator {
	constructor(private readonly options: SdkTaskStartCoordinatorOptions) {}

	async initTask(
		prompt?: string,
		images?: string[],
		files?: string[],
		historyItem?: HistoryItem,
		taskSettings?: Partial<Settings>,
	): Promise<string | undefined> {
		Logger.log(`[SdkController] initTask called: "${prompt?.substring(0, 50)}"`)
		let taskSessionId: string | undefined
		let providerId: string | undefined
		let modelId: string | undefined
		try {
			// Cline Cubed: bookkeeping only. Chats run side by side, so starting a new one must
			// never stop the session another surface is showing.
			await this.options.clearTask({ stopActiveSession: false })

			const cwd = await this.options.getWorkspaceRoot()
			const mode = this.getCurrentMode()
			Logger.log(`[SdkController] Building session config: mode=${mode}, cwd=${cwd}`)
			const config = await this.options.sessionConfigBuilder.build({
				prompt,
				images,
				files,
				historyItem,
				taskSettings,
				cwd,
				mode,
			})
			providerId = config.providerId
			modelId = config.modelId

			Logger.log(
				`[SdkController] Session config: provider=${config.providerId}, model=${config.modelId}, hasApiKey=${!!config.apiKey}`,
			)

			if (usesClineAccountAuth(config.providerId) && !config.apiKey) {
				Logger.warn(
					`[SdkController] ${config.providerId} provider selected but no Cline auth token — emitting auth error`,
				)
				// No task/session id exists yet, so this preflight auth UI path is
				// intentionally not recorded as task-joinable provider error telemetry.
				this.options.emitClineAuthError(prompt)
				return undefined
			}

			taskSessionId = config.sessionId?.trim() || createSessionId()
			// This session's own turn phase, stamped at the moment its id exists. The chat's
			// snapshot reads the per-session tracker, so without this the whole first turn runs
			// at phase "idle" — no thinking indicator, no Cancel control, and a live input.
			this.options.setTurnPhase?.("streaming", undefined, taskSessionId)
			const configWithSessionId = {
				...config,
				sessionId: taskSessionId,
			}

			const startInput = this.options.buildStartSessionInput(configWithSessionId, {
				prompt: prompt,
				images,
				files,
				historyItem,
				taskSettings,
				cwd,
				mode,
			})

			const task = this.createAndSetTask(taskSessionId)
			this.emitInitialTaskMessage(taskSessionId, prompt ?? "", images, files)

			// The session's phase was stamped "streaming" above, at the moment its id was minted,
			// but the webview only learns the phase through a full state post. Ship one now, in
			// parallel with the potentially slow session startup below, so the chat shows the
			// thinking indicator (and offers Cancel) as soon as the task message lands instead of
			// after startNewSession settles.
			this.options.postStateToWebview().catch((error) => {
				Logger.error("[SdkController] Failed to post state after emitting initial task message:", error)
			})

			const { startResult, sdkHost } = await this.options.sessions.startNewSession(startInput)
			if (startResult.sessionId !== taskSessionId) {
				Logger.warn(
					`[SdkController] SDK returned session id ${startResult.sessionId} after requested id ${taskSessionId}`,
				)
				const requestedSessionId = taskSessionId
				task.taskId = startResult.sessionId
				taskSessionId = startResult.sessionId
				// Same re-key as the resume paths: alias the proxy under the live id and let the
				// controller move any chat-surface binding, or later lookups by one of the two
				// ids miss and fall into fallback routing.
				this.options.setTask(task)
				this.options.onSessionIdChanged?.(requestedSessionId, startResult.sessionId, task)
			}

			const newHistoryItem = this.options.createHistoryItemFromSession(
				taskSessionId,
				prompt ?? "",
				configWithSessionId.modelId,
				cwd,
			)
			await this.options.taskHistory.updateTaskHistoryItem(newHistoryItem)
			await this.options.postStateToWebview()

			if (prompt?.trim() || images?.length || files?.length) {
				Logger.log(`[SdkController] Sending prompt to session: ${taskSessionId}`)
				const resolvedTask = await this.options.resolveContextMentions(prompt || "")
				this.options.sessions.fireAndForgetSend(sdkHost, taskSessionId, resolvedTask, images, files)
			}

			Logger.log(`[SdkController] Task initialized: ${taskSessionId}`)
			return taskSessionId
		} catch (error) {
			this.options.captureProviderApiError?.({
				sessionId: taskSessionId,
				error,
				providerId,
				modelId,
				errorType: PROVIDER_FAILURE_ERROR_TYPE.TASK_INIT,
				failurePhase: PROVIDER_FAILURE_PHASE.PREFLIGHT,
			})
			this.handleInitError(error, taskSessionId)
			await this.options.postStateToWebview().catch((postError) => {
				Logger.error("[SdkController] Failed to post state after init error:", postError)
			})
			return undefined
		}
	}

	async reinitExistingTaskFromId(taskId: string): Promise<void> {
		try {
			// Cline Cubed: if the session is already live (still streaming), focus it IN
			// PLACE — no restart, no stop of any other session. Concurrent chats keep streaming
			// independently; only the fork's bookkeeping focus changes.
			const liveSession = this.options.sessions.getLiveSession(taskId)
			if (liveSession) {
				this.options.sessions.focusSession(taskId)
				this.createAndSetTask(taskId)
				await this.options.postStateToWebview()
				Logger.log(`[SdkController] Task focused (live session): ${taskId}`)
				return
			}

			// Bookkeeping only — do NOT stop the currently-focused session: it may be a
			// different chat that must keep streaming while this one is reinitialized (V7).
			await this.options.clearTask({ stopActiveSession: false })

			const historyItem = await this.options.taskHistory.findHistoryItem(taskId)
			if (!historyItem) {
				Logger.error(`[SdkController] Task not found in history: ${taskId}`)
				return
			}

			// A task's stored cwd may have been deleted/moved since the task ran
			// (or migrated from another machine) — feeding a stale path into the
			// session bootstrap makes workspace init fail. Fall back to the live
			// workspace root instead.
			const storedCwd = historyItem.cwdOnTaskInitialization
			const cwd = storedCwd && (await isDirectory(storedCwd)) ? storedCwd : await this.options.getWorkspaceRoot()
			const config = await this.options.sessionConfigBuilder.build({
				cwd,
				mode: "act",
			})

			const tempManager = await this.options.createTempSessionHost()
			const initialMessages = await this.options.loadInitialMessages(tempManager, taskId)
			await tempManager.dispose("readMessages")

			// Cline Cubed: resume UNDER THE TASK'S OWN ID (the same pin
			// prepareTaskResumeStartInput applies on the follow-up resume path). Without it the
			// runtime minted a fresh id for the resumed session while the surface registry, the
			// webview's message stamp, and the proxies map all still keyed the history id — so
			// every later lookup missed and fell into fallback routing.
			config.sessionId = taskId

			const { startResult } = await this.options.sessions.startNewSession({
				config,
				interactive: true,
				...(initialMessages ? { initialMessages: initialMessages as InitialMessages } : {}),
				sessionMetadata: historyItemToSessionMetadata(historyItem, config.modelId),
			})

			const task = this.createAndSetTask(taskId)
			if (startResult.sessionId !== taskId) {
				// The runtime declined the requested id — the exception, not the rule. Re-key the
				// proxy under the live id (the old entry stays as an alias, so responses stamped
				// with the history id still resolve to this proxy) and let the controller re-bind
				// the chat-surface registry.
				Logger.warn(`[SdkController] SDK returned session id ${startResult.sessionId} after requested id ${taskId}`)
				task.taskId = startResult.sessionId
				this.options.setTask(task)
				this.options.onSessionIdChanged?.(taskId, startResult.sessionId, task)
			}
			await this.options.postStateToWebview()

			Logger.log(`[SdkController] Task resumed: ${taskId} → ${startResult.sessionId}`)
		} catch (error) {
			this.handleReinitError(taskId, error)
		}
	}

	private getCurrentMode(): Mode {
		const m = this.options.stateManager.getGlobalSettingsKey("mode")
		return m === "plan" ? m : "act"
	}

	private createAndSetTask(sessionId: string): TaskProxy {
		const task = createTaskProxy(
			sessionId,
			(text?: string, images?: string[], files?: string[], proxySessionId?: string) =>
				this.options.onAskResponse(text, images, files, proxySessionId ?? sessionId),
			(proxySessionId?: string) => this.options.onCancelTask(proxySessionId ?? sessionId),
		)
		this.options.setTask(task)
		return task
	}

	private emitInitialTaskMessage(sessionId: string, task: string, images?: string[], files?: string[]): void {
		// Attachments must ride on the authoritative task message: the webview's
		// optimistic pending copy is only cleared once an identical message (text
		// AND images/files) arrives from the extension. Omitting them left the
		// optimistic message unconfirmed forever, so it was re-injected into the
		// transcript even after "New Task" cleared it (#12924).
		const taskMessage: ClineMessage = {
			ts: Date.now(),
			type: "say",
			say: "task",
			text: task,
			...(images?.length ? { images } : {}),
			...(files?.length ? { files } : {}),
			partial: false,
		}
		this.options.messages.appendAndEmit([taskMessage], {
			type: "status",
			payload: { sessionId, status: "running" },
		})
	}

	private handleInitError(error: unknown, sessionId?: string): void {
		const errorDetails =
			error instanceof Error ? `${error.name}: ${error.message}\n${error.stack?.substring(0, 500)}` : String(error)
		Logger.error(`[SdkController] Failed to init task: ${errorDetails}`)
		;(globalThis as Record<string, unknown>).__cline_last_init_error = errorDetails
		;(globalThis as Record<string, unknown>).__cline_last_init_error_raw = error
		this.options.messages.appendAndEmit(
			[
				{
					ts: Date.now(),
					type: "say",
					say: "error",
					text: `Failed to start task: ${error instanceof Error ? error.message : String(error)}`,
					partial: false,
				},
			],
			{ type: "status", payload: { sessionId: sessionId ?? "", status: "error" } },
		)
	}

	private handleReinitError(taskId: string, error: unknown): void {
		Logger.error("[SdkController] Failed to reinit task:", error)

		const reinitErrorMsg = error instanceof Error ? error.message : String(error)
		const isClineAuthReinit =
			this.options.isClineManagedProviderActive() &&
			(reinitErrorMsg.includes(CLINE_ACCOUNT_AUTH_ERROR_MESSAGE) ||
				reinitErrorMsg.toLowerCase().includes("missing api key") ||
				reinitErrorMsg.toLowerCase().includes("unauthorized"))

		if (isClineAuthReinit) {
			this.options.emitClineAuthError()
			return
		}

		this.options.messages.emitSessionEvents(
			[
				{
					ts: Date.now(),
					type: "say",
					say: "error",
					text: `Failed to resume task: ${reinitErrorMsg}`,
					partial: false,
				},
			],
			{ type: "status", payload: { sessionId: taskId, status: "error" } },
		)
	}
}
