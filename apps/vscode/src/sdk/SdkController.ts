// Replaces classic src/core/controller/index.ts (see origin/main)
//
// The SDK-backed Controller. It provides the same interface as the classic
// Controller but delegates session lifecycle (initTask, askResponse,
// cancelTask, …) to the Cline SDK (@cline/core) and bridges SDK events to
// the webview's gRPC streams.
import * as fs from "node:fs/promises"
import * as path from "node:path"
import {
	type CompareCheckpointResult,
	createRestoredCheckpointMetadata,
	createUserInstructionConfigService,
	ensureChatWorkspace,
	getProviderAuthStorageId,
	type PreparedRemoteConfigCoreIntegration,
	readSessionCheckpointHistory,
	resolveDefaultMcpSettingsPath,
	type SessionHistoryRecord,
	setTelemetryOptOutGlobally,
	type UserInstructionConfigService,
} from "@cline/core"
import { formatDisplayUserInput, type RemoteConfig, type RemoteConfigBundle } from "@cline/shared"
import { bindChatSurfaceToSession, chatSurfaceForSession, notifyChatTitleChanged } from "@core/controller/chat-surfaces"
import type { ApiConfiguration } from "@shared/api"
import type { ChatContent } from "@shared/ChatContent"
import { CLINE_ACCOUNT_AUTH_ERROR_MESSAGE } from "@shared/ClineAccount"
import { mentionRegexGlobal } from "@shared/context-mentions"
import type { ClineApiReqInfo, ClineMessage, ExtensionState, TurnPhase } from "@shared/ExtensionMessage"
import { chatDisplayTitle, type HistoryItem } from "@shared/HistoryItem"
import { DeleteAllTaskHistoryCount, type GetTaskHistoryRequest, TaskHistoryArray, TaskResponse } from "@shared/proto/cline/task"
import type { Settings } from "@shared/storage/state-keys"
import type { Mode } from "@shared/storage/types"
import type { TelemetrySetting } from "@shared/TelemetrySetting"
import type { ClineCheckpointRestore } from "@shared/WebviewMessage"
import { parseMentions } from "@/core/mentions"
import { ensureMcpServersDirectoryExists } from "@/core/storage/disk"
import { clearSdkRemoteConfig, refreshSdkRemoteConfig } from "@/core/storage/remote-config/sdk-refresh"
import { StateManager } from "@/core/storage/StateManager"
import { WorkspaceRootManager } from "@/core/workspace/WorkspaceRootManager"
import { HostProvider } from "@/hosts/host-provider"
import { VscodeTerminalManager } from "@/hosts/vscode/terminal/VscodeTerminalManager"
import { ExtensionRegistryInfo } from "@/registry"
import { OcaAuthService } from "@/services/auth/oca/OcaAuthService"
import { UrlContentFetcher } from "@/services/browser/UrlContentFetcher"
import { ClineError } from "@/services/error/ClineError"
import { McpHub } from "@/services/mcp/McpHub"
import { telemetryService } from "@/services/telemetry"
import type { ClineExtensionContext } from "@/shared/cline"
import { toLegacyApiProvider } from "@/shared/model-catalog/provider-helpers"
import { ShowMessageRequest, ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import { isClineManagedProvider } from "@/shared/utils/cline"
import { arePathsEqual, getDesktopDir } from "@/utils/path"
import { ClineAccountService } from "./account-service"
import { AuthService, LogoutReason } from "./auth-service"
import { BUILTIN_SLASH_COMMANDS } from "./builtin-slash-commands"
import { buildStartSessionInput, createHistoryItemFromSession } from "./cline-session-factory"
import { MessageTranslatorState, reshapeErrorForWebview } from "./message-translator"
import { createProviderCatalog } from "./model-catalog/catalog"
import type { Disposable, ProviderCatalog, ProviderConfigChange, ProviderConfigStore } from "./model-catalog/contracts"
import { parseProviderId } from "./model-catalog/provider-id"
import { createProviderConfigStore } from "./model-catalog/store"
import {
	PROVIDER_FAILURE_ERROR_TYPE,
	PROVIDER_FAILURE_PHASE,
	type ProviderFailureTelemetry,
	ProviderFailureTelemetryTurnGate,
} from "./provider-failure-telemetry"
import { RemoteConfigRefreshCoordinator } from "./remote-config-refresh-coordinator"
import {
	findVisibleCheckpointUserMessageByRun,
	getCheckpointRunCountForMessage,
	isVisibleCheckpointUserMessage,
} from "./sdk-checkpoints"
import { SdkCompactionCoordinator } from "./sdk-compaction-coordinator"
import { SdkDiffEditCoordinator } from "./sdk-diff-edit-coordinator"
import { SdkFollowupCoordinator } from "./sdk-followup-coordinator"
import { SdkForegroundCommandCoordinator } from "./sdk-foreground-command-coordinator"
import { SdkInteractionCoordinator } from "./sdk-interaction-coordinator"
import { SdkMcpCoordinator } from "./sdk-mcp-coordinator"
import { SdkMessageCoordinator, type SessionEventListener } from "./sdk-message-coordinator"
import { SdkModeCoordinator } from "./sdk-mode-coordinator"
import { SdkProviderChangeCoordinator } from "./sdk-provider-change-coordinator"
import { SdkSessionConfigBuilder } from "./sdk-session-config-builder"
import { SdkSessionEventCoordinator } from "./sdk-session-event-coordinator"
import { SdkSessionHistoryLoader } from "./sdk-session-history-loader"
import { SdkSessionLifecycle } from "./sdk-session-lifecycle"
import { SdkSessionRebuildScheduler } from "./sdk-session-rebuild-scheduler"
import { SdkTaskControlCoordinator } from "./sdk-task-control-coordinator"
import { SdkTaskHistory, sessionHistoryRecordToHistoryItem } from "./sdk-task-history"
import { SdkTaskStartCoordinator } from "./sdk-task-start-coordinator"
import { createVscodeSdkTelemetryHandle, type VscodeSdkTelemetryHandle } from "./sdk-telemetry"
import { SdkTerminalExecutionModeCoordinator } from "./sdk-terminal-execution-mode-coordinator"
import { isToolAutoApproved } from "./sdk-tool-policies"
import {
	extractSdkUserText,
	findSdkUserMessageIndexByOrdinal,
	getSdkCheckpointRunCountForMessageIndex,
	isSyntheticSdkUserMessage,
	type SdkUserMessage,
} from "./sdk-user-message-mapping"
import { buildDisabledWorkflowNames, expandSlashCommands } from "./slash-command-expansion"
import { StatePostDebouncer } from "./state-post-debouncer"
import { createTaskProxy, type TaskProxy } from "./task-proxy"
import { syncTelemetrySettingFromSharedGlobalSettings } from "./telemetry-settings-sync"
import { TurnStateTracker } from "./turn-state-tracker"
import { createWorkspaceFileReadExecutor } from "./vscode-file-read-executor"
import { VscodeSessionHost } from "./vscode-session-host"
import type { VscodeTerminalExecutionMode } from "./vscode-terminal-execution-mode"
import { WebviewGrpcBridge } from "./webview-grpc-bridge"
import { resolveWorkspaceManagerPaths, resolveWorkspaceRootPath } from "./workspace-root"

/**
 * Log a stub warning and return undefined.
 */
function stubWarn(name: string): void {
	Logger.warn(`[SdkController] STUB: ${name} not yet implemented`)
}

function metadataNumber(metadata: SessionHistoryRecord["metadata"] | undefined, key: string): number | undefined {
	const value = metadata?.[key]
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function usesClineAccountAuth(providerId: string): boolean {
	return getProviderAuthStorageId(providerId) === "cline"
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

function historyItemToTaskResponse(item: HistoryItem): TaskResponse {
	return TaskResponse.create({
		id: item.id,
		task: formatDisplayUserInput(item.task),
		ts: item.ts,
		isFavorited: item.isFavorited ?? false,
		size: item.size ?? 0,
		totalCost: item.totalCost ?? 0,
		tokensIn: item.tokensIn ?? 0,
		tokensOut: item.tokensOut ?? 0,
		cacheWrites: item.cacheWrites ?? 0,
		cacheReads: item.cacheReads ?? 0,
		isLegacy: item.isLegacy ?? false,
		title: item.title ?? "",
	})
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class Controller {
	// SDK session state and the coordinators that drive it.
	/**
	 * Cline Cubed: the ACTIVE chat's own name, when it has one.
	 *
	 * Held in memory because the state broadcast has to be synchronous and frequent, and because
	 * `currentTaskItem` cannot answer this — it is derived from the persisted taskHistory file and
	 * is undefined for a new or streaming task (same reason `activeTaskId` exists). Set when a chat
	 * is opened from history, cleared when a new chat starts, and updated by a rename.
	 */
	private activeTaskCustomTitle?: string
	private messageTranslatorState: MessageTranslatorState
	/**
	 * Cline Cubed: one translator per session. The translator holds single-stream bookkeeping
	 * (current streaming text/reasoning/tool row), so chats running side by side each need their
	 * own — otherwise two live streams would overwrite each other's in-flight rows. They share
	 * the process-wide id minter, which keeps message ids globally unique.
	 */
	private readonly translatorStates = new Map<string, MessageTranslatorState>()
	private turnStateTracker!: TurnStateTracker
	/** Cline Cubed: per-session turn-phase trackers for concurrent chats. */
	private readonly turnStateTrackers = new Map<string, TurnStateTracker>()
	/** Cline Cubed: per-session task proxies — every live session has its own proxy so
	 *  each chat's messages/turn state are read and written independently of the focused chat. */
	private readonly taskProxies = new Map<string, TaskProxy>()
	private messages: SdkMessageCoordinator
	private sessions: SdkSessionLifecycle
	private sessionRebuilds: SdkSessionRebuildScheduler
	private interactions: SdkInteractionCoordinator
	private diffEdits: SdkDiffEditCoordinator
	private sessionConfigBuilder: SdkSessionConfigBuilder
	private taskHistory: SdkTaskHistory
	private mode: SdkModeCoordinator
	private mcpTools: SdkMcpCoordinator
	private terminalExecutionMode: SdkTerminalExecutionModeCoordinator
	private providerChanges: SdkProviderChangeCoordinator
	private followups: SdkFollowupCoordinator
	private taskControl: SdkTaskControlCoordinator
	private taskStart: SdkTaskStartCoordinator
	private compaction: SdkCompactionCoordinator
	private sessionEvents: SdkSessionEventCoordinator
	private sessionHistory: SdkSessionHistoryLoader
	private readonly sdkTelemetry: VscodeSdkTelemetryHandle
	private readonly providerFailureTelemetryTurnGate = new ProviderFailureTelemetryTurnGate()
	private readonly providerConfigStore: ProviderConfigStore
	private readonly providerCatalog: ProviderCatalog
	private readonly providerConfigStoreSubscription: Disposable
	private providerConfigStatePostScheduled = false

	// Debounces/coalesces postStateToWebview() calls — see StatePostDebouncer.
	private static readonly STATE_POST_DEBOUNCE_MS = 50
	private readonly statePostDebouncer: StatePostDebouncer

	// Bridges SDK events to the webview's gRPC streams.
	private grpcBridge: WebviewGrpcBridge

	// Presents the Task interface that gRPC handlers expect, delegating to the
	// active SDK session.
	task?: TaskProxy

	mcpHub: McpHub
	accountService: ClineAccountService
	authService: AuthService
	ocaAuthService: OcaAuthService
	readonly stateManager: StateManager

	// Lazy terminal manager for foreground (VS Code terminal) command execution.
	// Created on first use; shared across all sessions in this Controller's lifetime.
	// Only used in the `vscodeTerminal` execution mode — `backgroundExec` and the
	// standalone (JetBrains/CLI) host run commands through the SDK's built-in tool.
	private _terminalManager?: VscodeTerminalManager

	// Registry of in-flight foreground (VS Code terminal) command executions.
	// Owned here — not by the session — so it survives session rebuilds, which
	// recreate the tool set. Drives the "Proceed While Running" button.
	private readonly foregroundCommands = new SdkForegroundCommandCoordinator({
		onRunningChanged: () => {
			void this.postStateToWebview()
		},
	})

	// Private state kept for stub compatibility
	private backgroundCommandRunning = false
	private backgroundCommandTaskId?: string
	private pendingClineAuthRetryPrompt?: string
	checkpointRestoreInput?: ExtensionState["checkpointRestoreInput"]

	// Timer for periodic remote config fetching (enterprise policy enforcement)
	private remoteConfigTimer?: NodeJS.Timeout
	private remoteConfigCoreIntegration?: PreparedRemoteConfigCoreIntegration
	private remoteConfigRevision = 0
	private remoteConfigAvailable = false
	private readonly remoteConfigRefreshCoordinator = new RemoteConfigRefreshCoordinator<boolean>((isCurrent) =>
		this.performRemoteConfigRefresh(isCurrent),
	)
	private resolveInitialRemoteConfigReady!: () => void
	private readonly initialRemoteConfigReady = new Promise<void>((resolve) => {
		this.resolveInitialRemoteConfigReady = resolve
	})

	// Watches user-instruction files (workflows/skills/rules), including those
	// materialized by remote config under `.cline/remote-config/`. Used to expand
	// `/workflow` and `/skill` slash commands into their instruction bodies before
	// the prompt reaches the model — the same mechanism the CLI uses in
	// `buildUserInputMessage`. The agent loop never auto-expands commands, so this
	// host-side expansion is required. Created lazily (memoized as a promise to be
	// race-free under concurrent first sends) and rebuilt if the workspace root
	// changes.
	private userInstructionService?: Promise<UserInstructionConfigService>
	private userInstructionServiceRoot?: string
	private isDisposed = false

	// Synchronous snapshot of getWorkspaceRoot()'s latest result, for the message
	// translator (which runs synchronously and relativizes the tool paths shown in
	// the chat view). Warmed in the constructor and refreshed on every call.
	private lastKnownWorkspaceRoot?: string

	get remoteConfig(): RemoteConfig | undefined {
		return this.remoteConfigCoreIntegration?.prepared.bundle?.remoteConfig
	}

	get remoteConfigBundle(): RemoteConfigBundle | undefined {
		return this.remoteConfigCoreIntegration?.prepared.bundle
	}

	get isRemoteConfigAvailable(): boolean {
		return this.remoteConfigAvailable
	}

	get currentRemoteConfigRevision(): number {
		return this.remoteConfigRevision
	}

	constructor(readonly context: ClineExtensionContext) {
		// StateManager must be initialized before creating the Controller
		this.stateManager = StateManager.get()
		syncTelemetrySettingFromSharedGlobalSettings(this.stateManager)
		this.sdkTelemetry = createVscodeSdkTelemetryHandle()
		this.statePostDebouncer = new StatePostDebouncer({
			debounceMs: Controller.STATE_POST_DEBOUNCE_MS,
			flush: (sessionId) => this.flushStateToWebview(sessionId),
		})
		this.providerConfigStore = createProviderConfigStore()
		this.providerCatalog = createProviderCatalog(this.providerConfigStore)
		this.providerConfigStoreSubscription = this.providerConfigStore.subscribe((event) => {
			this.handleProviderConfigChange(event)
		})

		// IMPORTANT: Use ~/.cline/data/settings/ for the settings directory,
		// NOT ensureSettingsDirectoryExists() which returns the VSCode extension
		// storage path (HostProvider.globalStorageFsPath/settings/). The MCP
		// settings file lives at ~/.cline/data/settings/cline_mcp_settings.json
		// (shared across VSCode, CLI, and JetBrains clients).
		this.mcpHub = new McpHub(
			() => ensureMcpServersDirectoryExists(),
			async () => {
				const settingsDir = path.dirname(resolveDefaultMcpSettingsPath())
				await fs.mkdir(settingsDir, { recursive: true })
				return settingsDir
			},
			ExtensionRegistryInfo.version,
			telemetryService,
		)

		// Initialize SDK-backed auth and account services.
		this.authService = AuthService.getInstance(this, this.sdkTelemetry.telemetry)
		this.ocaAuthService = OcaAuthService.initialize(this)
		this.accountService = ClineAccountService.getInstance()

		// Initialize message translator state. The mode getter styles the inferred turn-final
		// completion row (plan → yellow plan box, act → green completion box).
		this.messageTranslatorState = new MessageTranslatorState(
			undefined,
			() => this.getActiveProviderId(),
			() => (this.stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"),
			() => this.lastKnownWorkspaceRoot,
			// Model backing the active turn — lets error reshaping recognize
			// retired cline-free/ models (the error payload itself never names one).
			// The task shim is preferred over session-start metadata: a mid-task
			// model-only switch updates the running session's model in place
			// (updateActiveSessionModel) and refreshes the shim, but never touches
			// startConfig/manifest, which would otherwise report the stale model.
			// The shim starts as "unknown" (filtered out by getTaskModelId), so
			// fresh sessions still resolve through their start metadata.
			() => this.getTaskModelId() ?? this.getSessionModelId(),
		)
		// Warm the synchronous workspace-root snapshot used for display-path
		// relativization (getWorkspaceRoot never rejects — it falls back internally).
		void this.getWorkspaceRoot()
		// Authoritative UI-mode tracker, sharing the one id/seq/epoch authority.
		this.turnStateTracker = new TurnStateTracker(this.messageTranslatorState.getMinter())
		this.messages = new SdkMessageCoordinator({
			// Messages belong to the session that produced them. STRICT: a named session with no
			// resident proxy gets NO task (appendMessages is null-safe and drops the write) —
			// never the focused one, which would splice another chat's events into this one.
			getTask: (sessionId) => (sessionId ? this.taskProxies.get(sessionId) : this.task),
			// Stamp seq/epoch on every message flowing to the webview from the shared authority.
			getMinter: () => this.messageTranslatorState.getMinter(),
		})
		this.sessionHistory = new SdkSessionHistoryLoader()
		this.sessionConfigBuilder = new SdkSessionConfigBuilder({
			stateManager: this.stateManager,
			emitHookMessage: (msg) => this.messages.emitHookMessage(msg),
			onConsecutiveMistakeLimitReached: (context) => this.interactions.handleConsecutiveMistakeLimitReached(context),
		})
		this.diffEdits = new SdkDiffEditCoordinator({
			getCwd: () => this.getWorkspaceRoot(),
			isBackgroundEditEnabled: () => !!this.stateManager.getGlobalSettingsKey("backgroundEditEnabled"),
		})
		this.interactions = new SdkInteractionCoordinator({
			messages: this.messages,
			getSessionId: () => this.sessions.getActiveSession()?.sessionId ?? "",
			// Validate an ask's claimed identity against the live-session map before keying a
			// pending under it. `this.sessions` is assigned later in this constructor; the
			// closure only runs at ask time, long after construction completes.
			isLiveSession: (sessionId) => !!this.sessions.getLiveSession(sessionId),
			postStateToWebview: (sessionId) => this.postStateToWebview(sessionId),
			// Share the single id/seq/epoch authority so interaction-minted ids (tool-approval
			// asks, ask_question, user_feedback) never collide with translator-minted ids.
			getMinter: () => this.messageTranslatorState.getMinter(),
			setTurnPhase: (phase, anchorTs, sessionId) => this.setPhaseForSession(phase, anchorTs, sessionId),
			// Open the diff editor preview before the approval buttons render.
			onToolApprovalAsk: (request) => this.diffEdits.openForApproval(request.toolCallId, request.toolName, request.input),
			recordApprovedToolMessage: (toolCallId, messageTs) =>
				this.messageTranslatorState.recordApprovedToolMessageTs(toolCallId, messageTs),
			recordDeniedToolApproval: (toolCallId, toolName, reason) => {
				this.messageTranslatorState.recordDeniedToolApproval(toolCallId, toolName, reason)
				// A denied edit's executor never runs, so close its diff preview here. Covers
				// manual Reject and clearPending (task cancel/abort) in one place.
				void this.diffEdits.discardPreview(toolCallId)
			},
			shouldAutoApproveTool: (request) => {
				const autoApprovalSettings = this.stateManager.getGlobalSettingsKey("autoApprovalSettings")
				return autoApprovalSettings ? isToolAutoApproved(request.toolName, autoApprovalSettings) : false
			},
			getCwd: () => this.lastKnownWorkspaceRoot,
		})
		this.sessions = new SdkSessionLifecycle({
			mcpHub: this.mcpHub,
			telemetry: this.sdkTelemetry.telemetry,
			requestToolApproval: (request) => this.interactions.handleRequestToolApproval(request),
			askQuestion: (question, options, context) => this.interactions.handleAskQuestion(question, options, context),
			editorExecutor: (input, cwd, context) => this.diffEdits.executeEditorTool(input, cwd, context),
			applyPatchExecutor: (input, cwd, context) => this.diffEdits.executeApplyPatchTool(input, cwd, context),
			// The SDK's built-in reader resolves relative paths against the extension
			// host's process.cwd() (usually "/"); resolve them against the workspace instead.
			readFileExecutor: createWorkspaceFileReadExecutor(() => this.getWorkspaceRoot()),
			onSessionEvent: (event) => {
				this.sessionEvents.handleSessionEvent(event).catch((err) => {
					Logger.error("[SdkController] Failed to handle session event:", err)
				})
			},
			onDidBecomeIdle: () => this.handleSessionBecameIdle(),
			// Drop per-session bookkeeping when a session ends.
			// Refresh every surface once a session's stop has LANDED — the post that carries the
			// final row, where a post fired beside the write would race it.
			onSessionStopped: () => {
				this.postStateToWebview().catch(() => {})
			},
			onSessionEnded: (sessionId) => {
				this.taskProxies.delete(sessionId)
				this.turnStateTrackers.delete(sessionId)
				this.disposeTranslatorFor(sessionId)
			},
			beforeStartSession: () => this.ensureRemoteConfigForSessionStart(),
			getRemoteConfigIntegration: () => this.remoteConfigCoreIntegration,
			foregroundCommands: this.foregroundCommands,
			getTerminalManager: () => {
				// Guarded by getEffectiveTerminalExecutionMode() at the read sites
				// (vscode-session-host.ts, sdk-terminal-execution-mode-coordinator.ts):
				// this factory itself is only invoked when a caller has already
				// resolved to "vscodeTerminal" mode on a real VS Code host, but
				// VscodeTerminalManager's constructor still assumes
				// vscode.window.onDidStartTerminalShellExecution exists, which the
				// standalone (JetBrains/CLI) stub does not provide.
				if (!this._terminalManager) {
					this._terminalManager = new VscodeTerminalManager()
					this.applyTerminalSettings(this._terminalManager)
					Logger.log("[SdkController] Created VscodeTerminalManager for foreground terminal execution")
				}
				return this._terminalManager
			},
			onSendStart: () => {
				this.beginProviderFailureTelemetryTurn()
			},
			// this.mode is assigned later in this constructor; the closure only
			// runs at send time, long after construction completes.
			consumeModeSwitchNotice: (sessionId) => this.mode.consumeModeSwitchNotice(sessionId),
			onSendComplete: async () => {
				// Normal flows close their diff sessions inline; anything left here is orphaned.
				void this.diffEdits.discardAllPreviews("turn complete")

				this.postStateToWebview().catch((err) => {
					Logger.error("[SdkController] Failed to post state after turn:", err)
				})
			},
			onSendError: async (error, sessionId) => {
				// A turn failed — the UI shows error recovery (Retry / Sign In / Add Credits).
				void this.diffEdits.discardAllPreviews("turn error")
				// The FAILING session's phase — a background chat's turn failure must not mark
				// the focused chat "error".
				this.setPhaseForSession("error", undefined, sessionId)
				const errorMessage = error instanceof Error ? error.message : String(error)
				const providerId = this.getSessionProviderId(sessionId) ?? this.getActiveProviderId()
				const isClineAuthError =
					isClineManagedProvider(providerId) &&
					(errorMessage.includes(CLINE_ACCOUNT_AUTH_ERROR_MESSAGE) ||
						errorMessage.toLowerCase().includes("missing api key") ||
						errorMessage.toLowerCase().includes("unauthorized"))

				if (isClineAuthError) {
					this.captureProviderFailure({
						sessionId,
						error,
						providerId,
						errorType: PROVIDER_FAILURE_ERROR_TYPE.AUTH,
						failurePhase: PROVIDER_FAILURE_PHASE.PREFLIGHT,
					})
					this.emitClineAuthError()
				} else if (isClineManagedProvider(providerId) && this.isClineBalanceError(errorMessage)) {
					this.captureProviderFailure({
						sessionId,
						error,
						providerId,
						errorType: PROVIDER_FAILURE_ERROR_TYPE.BALANCE,
						failurePhase: PROVIDER_FAILURE_PHASE.PREFLIGHT,
					})
					this.emitClineBalanceError(errorMessage)
				} else {
					this.captureProviderFailure({
						sessionId,
						error,
						providerId,
						errorType: PROVIDER_FAILURE_ERROR_TYPE.SEND_ERROR,
						failurePhase: PROVIDER_FAILURE_PHASE.STREAMING,
					})
					this.messages.emitSessionEvents(
						[
							{
								ts: Date.now(),
								type: "say",
								say: "error",
								text: `Agent error: ${errorMessage}`,
								partial: false,
							},
						],
						{ type: "status", payload: { sessionId, status: "error" } },
					)
				}
				this.postStateToWebview().catch(() => {})
			},
		})
		this.sessionRebuilds = new SdkSessionRebuildScheduler({ sessions: this.sessions })
		this.taskHistory = new SdkTaskHistory({
			mcpHub: this.mcpHub,
			sessions: this.sessions,
			legacyExtensionStorageDir: this.context.globalStorageUri.fsPath,
			telemetry: telemetryService,
			// History rendering mints ids from the shared authority so regenerated history ids
			// never overlap live-session ids.
			getMinter: () => this.messageTranslatorState.getMinter(),
		})
		this.mode = new SdkModeCoordinator({
			stateManager: this.stateManager,
			sessions: this.sessions,
			interactions: this.interactions,
			messages: this.messages,
			sessionConfigBuilder: this.sessionConfigBuilder,
			getTask: () => this.task,
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			loadInitialMessages: async (sdkHost, sessionId) =>
				(await this.sessionHistory.loadInitialMessages(sdkHost, sessionId)) ?? [],
			buildStartSessionInput,
			emitClineAuthError: () => this.emitClineAuthErrorWithTelemetry(),
			resetMessageTranslator: () => this.resetMessageTranslatorAndFence(),
			postStateToWebview: () => this.postStateToWebview(),
			getTurnPhase: () => this.turnStateTracker.currentPhase,
			setTurnPhase: (phase, anchorTs) => this.turnStateTracker.set(phase, anchorTs),
			resolveContextMentions: (text) => this.resolveContextMentions(text),
			rebuilds: this.sessionRebuilds,
			onAutoContinueStarting: () => {
				this.turnStateTracker.set("streaming")
				this.messageTranslatorState.clearTurnOutcome()
			},
			onAutoContinueFailed: () => {
				this.turnStateTracker.set("error")
			},
		})
		this.mcpTools = new SdkMcpCoordinator({
			stateManager: this.stateManager,
			sessions: this.sessions,
			messages: this.messages,
			sessionConfigBuilder: this.sessionConfigBuilder,
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			loadInitialMessages: async (sdkHost, sessionId) =>
				(await this.sessionHistory.loadInitialMessages(sdkHost, sessionId)) ?? [],
			buildStartSessionInput,
			postStateToWebview: () => this.postStateToWebview(),
			rebuilds: this.sessionRebuilds,
		})
		this.terminalExecutionMode = new SdkTerminalExecutionModeCoordinator({
			stateManager: this.stateManager,
			sessions: this.sessions,
			messages: this.messages,
			sessionConfigBuilder: this.sessionConfigBuilder,
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			loadInitialMessages: async (sdkHost, sessionId) =>
				(await this.sessionHistory.loadInitialMessages(sdkHost, sessionId)) ?? [],
			buildStartSessionInput,
			postStateToWebview: () => this.postStateToWebview(),
			rebuilds: this.sessionRebuilds,
		})
		this.providerChanges = new SdkProviderChangeCoordinator({
			stateManager: this.stateManager,
			sessions: this.sessions,
			messages: this.messages,
			sessionConfigBuilder: this.sessionConfigBuilder,
			getTask: () => this.task,
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			loadInitialMessages: async (sdkHost, sessionId) =>
				(await this.sessionHistory.loadInitialMessages(sdkHost, sessionId)) ?? [],
			buildStartSessionInput,
			postStateToWebview: () => this.postStateToWebview(),
			rebuilds: this.sessionRebuilds,
		})
		this.followups = new SdkFollowupCoordinator({
			stateManager: this.stateManager,
			interactions: this.interactions,
			sessions: this.sessions,
			messages: this.messages,
			taskHistory: this.taskHistory,
			sessionConfigBuilder: this.sessionConfigBuilder,
			waitForPendingRebuilds: async () => {
				await this.mode.waitForPendingRebuild()
				await this.sessionRebuilds.waitUntilSettled()
			},
			runExclusive: (operation) => this.sessionRebuilds.runExclusive(operation),
			// `sessionId` selects that session's OWN proxy. A zero-arg wiring here silently
			// discards the parameter, which turns every "per-session" lookup in the follow-up
			// coordinator into a read of the focused task.
			getTask: (sessionId) => (sessionId ? this.taskProxies.get(sessionId) : this.task),
			createTempSessionHost: () => this.createRemoteConfigAwareSessionHost(),
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			loadInitialMessages: (sessionHost, taskId) => this.sessionHistory.loadInitialMessages(sessionHost, taskId),
			buildStartSessionInput,
			resolveContextMentions: (text) => this.resolveContextMentions(text),
			isClineManagedProviderActive: () => this.isClineManagedProviderActive(),
			emitClineAuthError: () => this.emitClineAuthErrorWithTelemetry(),
			resetMessageTranslator: (sessionId) => this.resetMessageTranslatorAndFence(sessionId),
			postStateToWebview: (sessionId) => this.postStateToWebview(sessionId),
			onResumeFailed: (sessionId) => {
				this.setPhaseForSession("error", undefined, sessionId)
			},
			onFollowUpAbandoned: (sessionId) => {
				// Settle the streaming phase askResponse pre-set, unless a turn
				// (for example on the newly displayed task) has actually started.
				const tracker = this.getTurnStateTrackerFor(sessionId)
				const stillRunning = sessionId
					? !!this.sessions.getLiveSession(sessionId)?.isRunning
					: !!this.sessions.getActiveSession()?.isRunning
				if (tracker.currentPhase === "streaming" && !stillRunning) {
					this.setPhaseForSession("idle", undefined, sessionId)
				}
			},
			onSessionIdChanged: (previousSessionId, newSessionId, task) =>
				this.handleSessionIdChanged(previousSessionId, newSessionId, task),
		})
		this.taskControl = new SdkTaskControlCoordinator({
			sessions: this.sessions,
			interactions: this.interactions,
			messages: this.messages,
			taskHistory: this.taskHistory,
			getTask: () => this.task,
			setTask: (task) => {
				this.task = task
				// V7: every session gets its own proxy so concurrent chats read/write their own
				// message state and history independently of the focused chat.
				if (task) {
					this.taskProxies.set(task.taskId, task)
				}
			},
			onAskResponse: (
				text: string | undefined,
				images: string[] | undefined,
				files: string[] | undefined,
				sessionId?: string,
			) => this.askResponse(text, images, files, sessionId),
			resetMessageTranslator: () => this.resetMessageTranslatorAndFence(),
			// Bump the epoch synchronously before abort so straggler events from the cancelled
			// turn carry the old epoch and are dropped by the webview. The resumable phase is set
			// in SdkController.cancelTask before this runs.
			raiseCancelFence: (sessionId) => {
				// The CANCELLED session's own translator state; the epoch fence stays global.
				this.getTranslatorFor(sessionId).clearApprovedToolMessageTs()
				this.messageTranslatorState.getMinter().bumpEpoch()
			},
			setTurnPhase: (phase, anchorTs) => this.turnStateTracker.set(phase, anchorTs),
			postStateToWebview: () => this.postStateToWebview(),
			clearTaskSettings: () => this.stateManager.clearTaskSettings(),
		})
		this.taskStart = new SdkTaskStartCoordinator({
			stateManager: this.stateManager,
			sessions: this.sessions,
			messages: this.messages,
			taskHistory: this.taskHistory,
			sessionConfigBuilder: this.sessionConfigBuilder,
			buildStartSessionInput,
			createHistoryItemFromSession,
			clearTask: async (options) => {
				this.pendingClineAuthRetryPrompt = undefined
				await this.taskControl.clearTask(options)
			},
			setTask: (task) => {
				this.task = task
				// V7: every session gets its own proxy so concurrent chats read/write their own
				// message state and history independently of the focused chat.
				if (task) {
					this.taskProxies.set(task.taskId, task)
				}
			},
			onAskResponse: (
				text: string | undefined,
				images: string[] | undefined,
				files: string[] | undefined,
				sessionId?: string,
			) => this.askResponse(text, images, files, sessionId),
			onCancelTask: (sessionId) => this.cancelTask(sessionId),
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			createTempSessionHost: () => this.createRemoteConfigAwareSessionHost(),
			loadInitialMessages: (reader, taskId) => this.sessionHistory.loadInitialMessages(reader, taskId),
			resolveContextMentions: (text) => this.resolveContextMentions(text),
			isClineManagedProviderActive: () => this.isClineManagedProviderActive(),
			emitClineAuthError: (task) => this.emitClineAuthErrorWithTelemetry(task),
			captureProviderApiError: (event) => this.captureProviderFailure(event),
			postStateToWebview: () => this.postStateToWebview(),
			setTurnPhase: (phase, anchorTs, sessionId) => this.setPhaseForSession(phase, anchorTs, sessionId),
			onSessionIdChanged: (previousSessionId, newSessionId, task) =>
				this.handleSessionIdChanged(previousSessionId, newSessionId, task),
		})
		this.compaction = new SdkCompactionCoordinator({
			stateManager: this.stateManager,
			sessions: this.sessions,
			rebuilds: this.sessionRebuilds,
			messages: this.messages,
			taskHistory: this.taskHistory,
			sessionConfigBuilder: this.sessionConfigBuilder,
			getDisplayedTaskId: () => this.task?.taskId,
			createTempSessionHost: () => this.createRemoteConfigAwareSessionHost(),
			loadInitialMessages: (reader, taskId) => this.sessionHistory.loadInitialMessages(reader, taskId),
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			postStateToWebview: () => this.postStateToWebview(),
		})
		this.sessionEvents = new SdkSessionEventCoordinator({
			getTranslatorFor: (sessionId) => this.getTranslatorFor(sessionId),
			sessions: this.sessions,
			messages: this.messages,
			taskHistory: this.taskHistory,
			stateManager: this.stateManager,
			getTask: () => this.task,
			postStateToWebview: (sessionId) => this.postStateToWebview(sessionId),
			setTurnPhase: (phase, anchorTs, sessionId) => this.getTurnStateTrackerFor(sessionId).set(phase, anchorTs),
			getTurnPhase: (sessionId) => this.getTurnStateTrackerFor(sessionId).currentPhase,
			captureProviderApiError: (event) => this.captureProviderFailure(event),
			beginProviderFailureTelemetryTurn: () => this.beginProviderFailureTelemetryTurn(),
		})
		// Subscribe to MCP tool list changes so we can restart the SDK session
		// when servers are added/removed/reconnected. The SDK's DefaultSessionBuilder
		// does not support dynamic MCP tools, so we must restart the session.
		this.mcpHub.setToolListChangeCallback(() => this.mcpTools.handleToolListChanged())

		// Initialize gRPC bridge
		this.grpcBridge = new WebviewGrpcBridge(this.messageTranslatorState)

		// Wire the bridge to the controller's getStateToPostToWebview()
		// so state updates include messages, currentTaskItem, and task history
		this.grpcBridge.setGetStateFn((sessionId?: string) => this.getStateToPostToWebview(sessionId))

		// Register the bridge as a session event listener
		this.onSessionEvent(this.grpcBridge.createListener())

		// Restore auth state from secrets on startup, then start the remote
		// config polling timer (enterprise policy enforcement). The timer must
		// start after auth is restored so remote config can identify the user's
		// organization and apply org-level policies.
		this.authService
			.restoreRefreshTokenAndRetrieveAuthInfo()
			.then(async () => {
				try {
					await this.refreshRemoteConfig()
				} catch (err) {
					Logger.error("[SdkController] Initial remote config refresh failed:", err)
				}
				this.startRemoteConfigTimer()
			})
			.catch((err) => {
				Logger.error("[SdkController] Failed to restore auth state:", err)
			})
			.finally(() => {
				this.resolveInitialRemoteConfigReady()
			})

		Logger.log("[SdkController] Initialized with SDK adapter layer + gRPC bridge + auth services")
	}

	getProviderConfigStore(): ProviderConfigStore {
		return this.providerConfigStore
	}

	getProviderCatalog(): ProviderCatalog {
		return this.providerCatalog
	}

	invalidateProviderListings(): void {
		this.providerCatalog.invalidateProviderListings()
	}

	private handleProviderConfigChange(event: ProviderConfigChange): void {
		this.scheduleProviderConfigStatePost()

		if (event.kind === "selection" && this.isSelectionForActiveModeProvider(event)) {
			this.sessions
				?.updateActiveSessionModel(event.selection.modelId)
				.catch((error) => Logger.error("[SdkController] Failed to update active session model:", error))
		}
	}

	handleApiConfigurationChanged(previous: ApiConfiguration, next: ApiConfiguration): void {
		this.providerChanges.handleApiConfigurationChanged(previous, next)
	}

	handleTerminalExecutionModeChanged(previous: VscodeTerminalExecutionMode, next: VscodeTerminalExecutionMode): void {
		this.terminalExecutionMode.handleTerminalExecutionModeChanged(previous, next)
	}

	private handleSessionBecameIdle(): void {
		this.sessionRebuilds?.sessionBecameIdle()
	}

	private isSelectionForActiveModeProvider(event: Extract<ProviderConfigChange, { kind: "selection" }>): boolean {
		try {
			const modeValue = this.stateManager.getGlobalSettingsKey("mode")
			const mode = modeValue === "plan" ? "plan" : "act"
			if (event.mode !== mode) {
				return false
			}

			const apiConfig = this.stateManager.getApiConfiguration()
			const activeProvider = mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider
			if (activeProvider === undefined) {
				return false
			}
			// Normalize both sides so stale SDK spellings in cached state
			// (e.g. `openai-compatible`) still match the parse-normalized
			// event id and model-only commits keep the lightweight
			// in-session update path.
			return toLegacyApiProvider(activeProvider) === toLegacyApiProvider(event.providerId.toString())
		} catch {
			return false
		}
	}

	private scheduleProviderConfigStatePost(): void {
		if (this.providerConfigStatePostScheduled) {
			return
		}

		this.providerConfigStatePostScheduled = true
		queueMicrotask(() => {
			this.providerConfigStatePostScheduled = false
			this.postStateToWebview().catch((error) => {
				Logger.error("[SdkController] Failed to post state after provider config change:", error)
			})
		})
	}

	/**
	 * Starts the periodic remote config fetching timer. Fetches immediately
	 * and then every hour, to enforce enterprise policy (provider lockdown,
	 * MCP server management, OpenTelemetry, etc.).
	 */
	private startRemoteConfigTimer(): void {
		// Set up 1-hour interval
		this.remoteConfigTimer = setInterval(() => {
			this.refreshRemoteConfig().catch((err) => Logger.error("[SdkController] Remote config timer failed:", err))
		}, 3600000) // 1 hour
	}

	async refreshRemoteConfig(options: { force?: boolean } = {}): Promise<boolean> {
		const userId = this.authService.getInfo().user?.uid ?? "signed-out"
		const organizationId = this.authService.getActiveOrganizationId() ?? "no-org"
		return this.remoteConfigRefreshCoordinator.refresh(`${userId}:${organizationId}`, options)
	}

	async waitForInitialRemoteConfig(): Promise<void> {
		await this.initialRemoteConfigReady
	}

	async rematerializeRemoteConfig(): Promise<void> {
		// force: this runs right after a toggle/opt-out mutation; coalescing onto
		// an in-flight refresh that sampled the pre-mutation state would report
		// success while applying the old configuration.
		const refreshed = await this.refreshRemoteConfig({ force: true })
		if (!refreshed) {
			throw new Error("Could not apply managed configuration change. Check your connection and try again.")
		}
		// Cline Cubed: a managed-config change applies to EVERY chat, so every live session
		// ends — each by id, through the funnel, so end times and list refreshes stay honest.
		// Ending only the ACTIVE session killed one chat the user never touched (chosen by
		// focus accident) and left every other chat running under the OLD configuration.
		for (const sessionId of this.sessions.getLiveSessionIds()) {
			await this.sessions.endActiveSession("remoteConfigToggle", { awaitStop: true, sessionId })
		}
		await this.postStateToWebview()
	}

	private async ensureRemoteConfigForSessionStart(): Promise<void> {
		const startedAt = Date.now()
		await this.waitForInitialRemoteConfig()
		let refreshed = false
		try {
			refreshed = await this.refreshRemoteConfig()
		} catch (error) {
			// A rejected refresh must degrade to the same fallback logic as a
			// false return: otherwise a filesystem error on the clear path (e.g.
			// EACCES on the remote-config workspace) blocks even unmanaged users
			// from starting sessions with a raw fs error.
			Logger.error("[SdkController] Remote config refresh threw during session gate:", error)
		}
		const activeOrganizationId = this.authService.getActiveOrganizationId()
		if (refreshed) {
			void telemetryService.captureRemoteConfigSessionGate({
				outcome: "refreshed",
				durationMs: Date.now() - startedAt,
				managed: Boolean(activeOrganizationId),
			})
			return
		}

		if (!activeOrganizationId) {
			if (this.stateManager.getGlobalStateKey("lastManagedOrganizationId")) {
				// This install last ran under organization policy, but the current
				// identity could not be resolved (refresh failed and no org was
				// restored — e.g. the API is unreachable). Fail closed rather than
				// starting an unpoliced session.
				void telemetryService.captureRemoteConfigSessionGate({
					outcome: "blocked",
					durationMs: Date.now() - startedAt,
					managed: true,
				})
				throw new Error("Could not verify organization policy. Check your connection and try again.")
			}
			// No organization policy applies to personal or signed-out use; a
			// failed refresh must not block local work.
			void telemetryService.captureRemoteConfigSessionGate({
				outcome: "unmanaged",
				durationMs: Date.now() - startedAt,
				managed: false,
			})
			return
		}

		const bundleOrganizationId = this.remoteConfigBundle?.metadata?.organizationId
		if (bundleOrganizationId === activeOrganizationId) {
			Logger.warn("[SdkController] Remote config refresh failed; starting with last known-good organization policy")
			void telemetryService.captureRemoteConfigSessionGate({
				outcome: "last_known_good",
				durationMs: Date.now() - startedAt,
				managed: true,
			})
			return
		}
		void telemetryService.captureRemoteConfigSessionGate({
			outcome: "blocked",
			durationMs: Date.now() - startedAt,
			managed: true,
		})
		throw new Error("Could not verify organization policy. Check your connection and try again.")
	}

	private createRemoteConfigAwareSessionHost(): Promise<VscodeSessionHost> {
		return VscodeSessionHost.create({
			mcpHub: this.mcpHub,
			beforeStartSession: () => this.ensureRemoteConfigForSessionStart(),
			getRemoteConfigIntegration: () => this.remoteConfigCoreIntegration,
		})
	}

	private async performRemoteConfigRefresh(isCurrent: () => boolean): Promise<boolean> {
		const refreshed = await refreshSdkRemoteConfig(this, {
			workspacePath: await this.getRemoteConfigWorkspacePath(),
			isCurrent,
		})
		if (!isCurrent()) {
			return false
		}
		// Remote config may have materialized new workflows/skills/rules under
		// `.cline/remote-config/`. Refresh the watcher so slash-command expansion
		// sees them without waiting on filesystem events.
		await this.refreshUserInstructionWatchers()
		return refreshed
	}

	setRemoteConfigAvailable(available: boolean): void {
		this.remoteConfigAvailable = available
	}

	async setRemoteConfigCoreIntegration(integration: PreparedRemoteConfigCoreIntegration | undefined): Promise<void> {
		const previous = this.remoteConfigCoreIntegration
		this.remoteConfigCoreIntegration = integration
		if (previous !== integration) {
			this.remoteConfigRevision += 1
		}
		if (previous && previous !== integration) {
			try {
				await previous.dispose()
			} catch (error) {
				Logger.error("[SdkController] Failed to dispose previous remote config integration:", error)
			}
		}
	}

	async invalidateUserInstructionService(): Promise<void> {
		const userInstructionServicePromise = this.userInstructionService
		this.userInstructionService = undefined
		this.userInstructionServiceRoot = undefined
		if (userInstructionServicePromise) {
			await userInstructionServicePromise.then((service) => service.stop()).catch(() => {})
		}
	}

	async dispose(): Promise<void> {
		this.providerConfigStoreSubscription.dispose()
		// Clear the remote config timer to prevent stale fetches
		if (this.remoteConfigTimer) {
			clearInterval(this.remoteConfigTimer)
			this.remoteConfigTimer = undefined
		}
		await this.setRemoteConfigCoreIntegration(undefined)
		this.isDisposed = true
		// Tear down the debounced state-post machinery before downstream resources
		// are disposed below — see StatePostDebouncer.dispose().
		await this.statePostDebouncer.dispose()
		await this.invalidateUserInstructionService()
		this.messages.cancelPendingSave()
		// Every session's pending ask/approval is settled on disposal so no agent run stays
		// suspended on a promise nothing can resolve. (clearTask below clears only the focused
		// session's; disposal is the one place a blanket clear is correct.)
		this.interactions.clearAllPending("Controller disposed")
		// Clear MCP tool list change callback before disposing McpHub
		this.mcpHub?.clearToolListChangeCallback()
		await this.diffEdits.discardAllPreviews("controller dispose")
		await this.clearTask()
		await this.sessions.dispose("SdkController.dispose")
		await this.taskHistory.dispose()
		this.mcpHub?.dispose?.()
		this.messages.dispose()
		await this.sdkTelemetry.dispose()
		Logger.log("[SdkController] Disposed")
	}

	// ---- Slash command + context mention resolution ----

	/**
	 * Lazily create (or rebuild on workspace-root change) the user-instruction
	 * watcher. Pointed at the workspace root so it discovers both local config
	 * (`.clinerules/workflows`, `.cline/workflows`, …) and remote-config files
	 * materialized under `<root>/.cline/remote-config/{workflows,skills,rules}`.
	 *
	 * `workspaceRoot` is resolved by the caller so the memoization check below runs
	 * synchronously on entry — there is no `await` before the assignment, so
	 * concurrent callers cannot create two competing watchers.
	 */
	private ensureUserInstructionService(workspaceRoot: string): Promise<UserInstructionConfigService> {
		// dispose() may have run during an awaited gap in the caller. Don't
		// resurrect a watcher the dispose path will never stop again.
		if (this.isDisposed) {
			return Promise.reject(new Error("Controller disposed"))
		}
		if (this.userInstructionService && this.userInstructionServiceRoot === workspaceRoot) {
			return this.userInstructionService
		}
		// Workspace root changed: stop the previous watcher once it settles.
		const previous = this.userInstructionService
		if (previous) {
			previous.then((service) => service.stop()).catch(() => {})
		}
		this.userInstructionServiceRoot = workspaceRoot
		this.userInstructionService = (async () => {
			const service = createUserInstructionConfigService({
				workflows: { workspacePath: workspaceRoot },
				skills: {
					workspacePath: workspaceRoot,
					includePluginSkills: true,
					cwd: workspaceRoot,
				},
				rules: { workspacePath: workspaceRoot },
			})
			// start() runs the initial scan; await so the snapshot is populated
			// before the first resolveRuntimeSlashCommand call.
			await service.start().catch((error) => {
				Logger.warn("[SdkController] Failed to start user instruction watcher:", error)
			})
			return service
		})()
		return this.userInstructionService
	}

	/**
	 * Expand a `/workflow` or `/skill` slash command into its instruction body.
	 * Serves the same purpose as the CLI's `buildUserInputMessage`, but is more
	 * permissive than the SDK's leading-only resolver: it accepts the legacy
	 * `/my-workflow.md` spelling the webview autocomplete inserts, matches
	 * commands mid-message (anything the chat input highlights as a command),
	 * and honors the user's workflow enable/disable toggles. Returns the input
	 * unchanged if no known command matches or expansion fails.
	 */
	private async resolveSlashCommands(text: string): Promise<string> {
		if (this.isDisposed) {
			return text
		}
		try {
			const workspaceRoot = await this.getWorkspaceRoot()
			const service = await this.ensureUserInstructionService(workspaceRoot)
			const remoteWorkflows = this.stateManager.getRemoteConfigSettings()?.remoteGlobalWorkflows ?? []
			const workflowRecords = service.listRecords("workflow").map((record) => ({
				id: record.id,
				name: record.item.name,
				filePath: record.filePath,
			}))
			const disabledWorkflowNames = buildDisabledWorkflowNames({
				records: workflowRecords,
				globalToggles: this.stateManager.getGlobalSettingsKey("globalWorkflowToggles"),
				workspaceToggles: this.stateManager.getWorkspaceStateKey("workflowToggles"),
				remoteToggles: this.stateManager.getGlobalStateKey("remoteWorkflowToggles"),
				remoteAlwaysEnabledNames: remoteWorkflows.filter((workflow) => workflow.alwaysEnabled).map((w) => w.name),
			})
			return expandSlashCommands(text, [...service.listRuntimeCommands(), ...BUILTIN_SLASH_COMMANDS], {
				disabledWorkflowNames,
				workflowRecords,
			})
		} catch (error) {
			Logger.warn("[SdkController] Slash command resolution failed, using raw text:", error)
			return text
		}
	}

	/**
	 * Refresh the user-instruction watcher after remote config is (re)materialized
	 * so newly written workflows/skills/rules are picked up immediately rather than
	 * waiting on filesystem watch events.
	 */
	private async refreshUserInstructionWatchers(): Promise<void> {
		const servicePromise = this.userInstructionService
		if (!servicePromise) {
			return
		}
		try {
			const service = await servicePromise
			await Promise.all([service.refreshType("workflow"), service.refreshType("skill"), service.refreshType("rule")])
		} catch (error) {
			Logger.warn("[SdkController] Failed to refresh user instruction watchers:", error)
		}
	}

	/**
	 * Expand slash commands, then resolve `@` context mentions in user text
	 * before sending to the SDK.
	 *
	 * `parseMentions()` inlines file content (`@/path`), URL content
	 * (`@https://...`), diagnostics (`@problems`), git state (`@git-changes`),
	 * and commit info (`@hash`) into the prompt text. We do this here because
	 * the SDK's own mention enricher only handles simple `@path` file mentions
	 * and does not understand the webview's `@/path` format or special
	 * mentions, so the LLM would otherwise never see the referenced content.
	 */
	private async resolveContextMentions(text: string): Promise<string> {
		const withCommands = await this.resolveSlashCommands(text)

		// Quick check: skip mention parsing if there are no @ mentions
		if (!mentionRegexGlobal.test(withCommands)) {
			return withCommands
		}
		// Reset lastIndex since RegExp.test() advances it for global regexes
		mentionRegexGlobal.lastIndex = 0

		try {
			const cwd = await this.getWorkspaceRoot()
			const urlContentFetcher = new UrlContentFetcher()
			const workspaceManager = await this.ensureWorkspaceManager()
			const resolved = await parseMentions(withCommands, cwd, urlContentFetcher, undefined, workspaceManager)
			Logger.log(`[SdkController] Resolved context mentions (${withCommands.length} → ${resolved.length} chars)`)
			return resolved
		} catch (error) {
			Logger.error("[SdkController] Failed to resolve context mentions, using raw text:", error)
			return withCommands
		}
	}

	// ---- Workspace root resolution ----

	/**
	 * Get the user's workspace root directory.
	 *
	 * In VSCode this resolves to `vscode.workspace.workspaceFolders[0]` via
	 * `HostProvider.workspace.getWorkspacePaths()`. If no workspace folder is
	 * open, it falls back to the SDK's shared chat workspace (see
	 * getNoWorkspaceFallback).
	 * This avoids using the VS Code extension host's `process.cwd()` (often `/`),
	 * which produces invalid SDK workspace metadata with an empty hint.
	 */
	private async getWorkspaceRoot(): Promise<string> {
		try {
			const { paths } = await HostProvider.workspace.getWorkspacePaths({})
			const workspaceRoot = paths?.find((workspacePath) => workspacePath.trim().length > 0)
			if (workspaceRoot) {
				this.lastKnownWorkspaceRoot = workspaceRoot
				return workspaceRoot
			}
		} catch (error) {
			Logger.warn("[SdkController] Failed to get workspace paths, using the no-workspace fallback:", error)
		}
		this.lastKnownWorkspaceRoot = await this.getNoWorkspaceFallback()
		return this.lastKnownWorkspaceRoot
	}

	private noWorkspaceFallbackPromise?: Promise<string>

	/**
	 * Directory used when no workspace folder is open: the SDK's shared chat
	 * workspace (`~/.cline/data/workspaces/chat`, seeded with an AGENTS.md
	 * etiquette file), matching how the desktop app and CLI host sessions
	 * started without a project. Desktop is only a last resort when the chat
	 * workspace cannot be created. Memoized so repeated no-workspace calls
	 * don't re-touch the filesystem.
	 */
	private getNoWorkspaceFallback(): Promise<string> {
		this.noWorkspaceFallbackPromise ??= (async () => {
			try {
				return await ensureChatWorkspace()
			} catch (error) {
				Logger.warn("[SdkController] Failed to prepare the chat workspace, falling back to Desktop:", error)
				// Don't memoize the degraded result; retry the chat workspace next time.
				this.noWorkspaceFallbackPromise = undefined
				return getDesktopDir()
			}
		})()
		return this.noWorkspaceFallbackPromise
	}

	private async getRemoteConfigWorkspacePath(): Promise<string | undefined> {
		try {
			const { paths } = await HostProvider.workspace.getWorkspacePaths({})
			if (!paths.length) {
				return undefined
			}
			return resolveWorkspaceRootPath(paths, paths[0])
		} catch (error) {
			Logger.warn("[SdkController] Failed to get workspace paths for remote config, using global fallback:", error)
			return undefined
		}
	}

	// ---- Session event subscription ----

	/**
	 * Subscribe to session events translated to ClineMessages.
	 * Returns an unsubscribe function.
	 */
	onSessionEvent(listener: SessionEventListener): () => void {
		return this.messages.onSessionEvent(listener)
	}

	/**
	 * Get the active API provider for the current mode.
	 */
	private getActiveProviderId(): string | undefined {
		try {
			const apiConfig = this.stateManager.getApiConfiguration()
			const modeValue = this.stateManager.getGlobalSettingsKey("mode")
			const mode = modeValue === "plan" ? "plan" : "act"
			return mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider
		} catch {
			return undefined
		}
	}

	private getTaskModelId(): string | undefined {
		const modelId = this.task?.api?.getModel?.().id?.trim()
		return modelId && modelId !== "unknown" ? modelId : undefined
	}

	private getSessionProviderId(sessionId?: string): string | undefined {
		const activeSession = this.sessions.getActiveSession()
		if (sessionId && activeSession?.sessionId !== sessionId) {
			return undefined
		}
		const providerId =
			activeSession?.startResult?.manifest?.provider?.trim() || activeSession?.startConfig?.providerId?.trim()
		return providerId && providerId !== "unknown" ? providerId : undefined
	}

	private getSessionModelId(sessionId?: string): string | undefined {
		const activeSession = this.sessions.getActiveSession()
		if (sessionId && activeSession?.sessionId !== sessionId) {
			return undefined
		}
		const modelId = activeSession?.startResult?.manifest?.model?.trim() || activeSession?.startConfig?.modelId?.trim()
		return modelId && modelId !== "unknown" ? modelId : undefined
	}

	private beginProviderFailureTelemetryTurn(): void {
		this.providerFailureTelemetryTurnGate.beginTurn()
	}

	/**
	 * Check if the active API provider uses Cline account auth for the current mode.
	 */
	private isClineManagedProviderActive(): boolean {
		return isClineManagedProvider(this.getActiveProviderId())
	}

	private captureProviderFailure(event: ProviderFailureTelemetry): void {
		const ulid = event.sessionId ?? this.task?.taskId ?? this.sessions.getActiveSession()?.sessionId
		if (!ulid) {
			return
		}
		if (
			event.failurePhase === PROVIDER_FAILURE_PHASE.STREAMING &&
			!this.providerFailureTelemetryTurnGate.shouldCaptureStreamingFailure()
		) {
			return
		}

		const provider = event.providerId ?? this.getSessionProviderId(event.sessionId) ?? "unknown"
		const model = event.modelId ?? this.getSessionModelId(event.sessionId) ?? this.getTaskModelId() ?? "unknown"
		const clineError = ClineError.transform(event.error, model, provider)

		telemetryService.captureProviderApiError({
			ulid,
			model,
			provider,
			errorMessage: clineError.message || String(event.error),
			errorStatus: clineError.status,
			requestId: clineError.requestId,
			errorType: event.errorType,
			failurePhase: event.failurePhase,
			// Every event here is a failure the user actually saw: transient
			// errors are retried inside the provider layer before any event
			// reaches this adapter, and recoverable in-run notices are filtered
			// out upstream. The legacy extension applies the same
			// surfaced-failures-only rule at its emission sites, so the A/B
			// cohorts compare directly with no query-side filtering.
		})
	}

	private emitClineAuthErrorWithTelemetry(task?: string, sessionId?: string): void {
		this.emitClineAuthError(task)
		this.captureProviderFailure({
			sessionId: sessionId ?? this.task?.taskId,
			error: CLINE_ACCOUNT_AUTH_ERROR_MESSAGE,
			providerId: this.getActiveProviderId(),
			errorType: PROVIDER_FAILURE_ERROR_TYPE.AUTH,
			failurePhase: PROVIDER_FAILURE_PHASE.PREFLIGHT,
		})
	}

	/**
	 * Emit a proper auth error for the 'cline' provider when the user is not
	 * logged in. The message sequence drives ErrorRow to render the
	 * "Sign in to Cline" button.
	 *
	 * Message sequence:
	 *   1. say:'task'           – the user's message text
	 *   2. say:'api_req_started' – opens the API request row
	 *   3. ask:'api_req_failed'  – ClineError JSON → ErrorRow renders auth UI
	 */
	private emitClineAuthError(task?: string): void {
		const ts = Date.now()
		this.pendingClineAuthRetryPrompt = task

		if (!this.task) {
			this.task = createTaskProxy(
				`auth-error-${ts}`,
				(text?: string, images?: string[], files?: string[], proxySessionId?: string) =>
					this.askResponse(text, images, files, proxySessionId),
				(proxySessionId?: string) => this.cancelTask(proxySessionId),
			)
		}

		const clineError = new ClineError(
			{ message: CLINE_ACCOUNT_AUTH_ERROR_MESSAGE, status: 401 },
			undefined, // modelId
			"cline",
		)
		const serializedError = clineError.serialize()

		const failedAskTs = ts + 2
		const messages: ClineMessage[] = [
			{
				ts,
				type: "say",
				say: "task",
				text: task ?? "",
				partial: false,
			},
			{
				ts: ts + 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					streamingFailedMessage: serializedError,
				} satisfies ClineApiReqInfo),
				partial: false,
			},
			{
				ts: failedAskTs,
				type: "ask",
				ask: "api_req_failed",
				text: serializedError,
				partial: false,
			},
		]

		this.turnStateTracker.set("error", failedAskTs)

		this.messages.appendAndEmit(messages, {
			type: "status",
			payload: {
				sessionId: this.sessions.getActiveSession()?.sessionId ?? "",
				status: "error",
			},
		})

		this.postStateToWebview().catch(() => {})
	}

	/**
	 * Check if an error message indicates an insufficient credits / balance error
	 * by reshaping it into ClineError format and inspecting the result.
	 */
	private isClineBalanceError(errorMessage: string): boolean {
		try {
			const shaped = JSON.parse(reshapeErrorForWebview({ message: errorMessage }))
			return shaped.code === "insufficient_credits"
		} catch {
			return false
		}
	}

	/**
	 * Emit a balance error for the 'cline' provider when the user has insufficient
	 * credits. Produces the same message sequence as emitClineAuthError so the
	 * webview renders the "Buy Credits" button via CreditLimitError.
	 *
	 * Message sequence:
	 *   1. say:'api_req_started' – streamingFailedMessage holds the ClineError JSON
	 *   2. ask:'api_req_failed'  – ClineError JSON → ErrorRow renders balance UI
	 */
	private emitClineBalanceError(rawErrorMessage: string): void {
		const ts = Date.now()

		// reshapeErrorForWebview extracts structured fields from the SDK error
		// message (which may be plain text or embedded JSON) and produces the
		// ClineError-serialized JSON that the webview's ErrorRow expects.
		const serializedError = reshapeErrorForWebview({
			message: rawErrorMessage,
		})

		const failedAskTs = ts + 1
		const messages: ClineMessage[] = [
			{
				ts,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					streamingFailedMessage: serializedError,
				} satisfies ClineApiReqInfo),
				partial: false,
			},
			{
				ts: failedAskTs,
				type: "ask",
				ask: "api_req_failed",
				text: serializedError,
				partial: false,
			},
		]

		this.turnStateTracker.set("error", failedAskTs)

		this.messages.appendAndEmit(messages, {
			type: "status",
			payload: {
				sessionId: this.sessions.getActiveSession()?.sessionId ?? "",
				status: "error",
			},
		})

		this.postStateToWebview().catch(() => {})
	}

	// ---- Task lifecycle ----

	async initTask(
		prompt?: string,
		images?: string[],
		files?: string[],
		historyItem?: HistoryItem,
		taskSettings?: Partial<Settings>,
	): Promise<string | undefined> {
		await this.waitForInitialRemoteConfig()
		// A new task is starting — the agent is about to stream. This write covers the FOCUSED
		// tracker only, for identity-less consumers (the new task becomes the focused one moments
		// later, in the coordinator's createAndSetTask). The phase the webview actually renders is
		// per-session, and the task-start coordinator stamps it the moment the session id is
		// minted — this line does not reach the webview and must not be mistaken for doing so.
		this.turnStateTracker.set("streaming")
		// Clear the previous turn's completion signal so this turn's phase is computed fresh.
		this.messageTranslatorState.clearTurnOutcome()
		// Cline Cubed: a chat resumed from history brings its name; a brand new one has none.
		this.activeTaskCustomTitle = historyItem?.title
		return this.taskStart.initTask(prompt, images, files, historyItem, taskSettings)
	}

	/**
	 * Cline Cubed: close ONE session by id — the in-chat close control's path.
	 *
	 * Ends that session (stopping its stream if it is mid-turn) and, when it happens to be the
	 * focused one, clears the focused-task pointer. Other chats are untouched: their sessions,
	 * proxies and translators live in per-session maps keyed by id, and per-session bookkeeping
	 * is dropped by onSessionEnded.
	 */
	async closeSession(sessionId: string): Promise<void> {
		await this.sessions.endActiveSession("closeSession", { sessionId })
		if (this.task?.taskId === sessionId) {
			this.task = undefined
			this.turnStateTracker.set("idle")
		}
		await this.postStateToWebview()
	}

	/**
	 * Cline Cubed: the task proxy for a specific session.
	 *
	 * Chats run side by side, so anything addressed to a conversation resolves it by session id
	 * rather than reading the focused chat. Returns undefined when that session is not resident.
	 */
	/**
	 * Cline Cubed: the translator for a session — created on first use, sharing the process-wide
	 * minter. Omitting `sessionId` returns the default translator.
	 */
	getTranslatorFor(sessionId?: string): MessageTranslatorState {
		if (!sessionId) {
			return this.messageTranslatorState
		}
		let translator = this.translatorStates.get(sessionId)
		if (!translator) {
			translator = new MessageTranslatorState(
				this.messageTranslatorState.getMinter(),
				() => this.getActiveProviderId(),
				() => (this.stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"),
				() => this.lastKnownWorkspaceRoot,
				() => this.getTaskModelId() ?? this.getSessionModelId(),
			)
			this.translatorStates.set(sessionId, translator)
		}
		return translator
	}

	/** Cline Cubed: drop a finished session's translator. */
	private disposeTranslatorFor(sessionId: string): void {
		this.translatorStates.delete(sessionId)
	}

	getTaskForSession(sessionId: string): TaskProxy | undefined {
		return this.taskProxies.get(sessionId)
	}

	async reinitExistingTaskFromId(taskId: string): Promise<void> {
		await this.waitForInitialRemoteConfig()
		// The reinstated session's own phase and turn outcome — plus the focused tracker, which
		// identity-less consumers read (reinit focuses the session it revives).
		this.turnStateTracker.set("streaming")
		this.getTurnStateTrackerFor(taskId).set("streaming")
		this.getTranslatorFor(taskId).clearTurnOutcome()
		this.messageTranslatorState.clearTurnOutcome()
		await this.taskStart.reinitExistingTaskFromId(taskId)
	}

	async cancelTask(sessionId?: string): Promise<void> {
		// Fence first: mark resumable before aborting so any straggler events from the aborted
		// turn land on the wrong side of the UI mode. (Full fence-before-abort epoch bump lands
		// in S6; this sets the authoritative phase now.)
		// Cline Cubed: `sessionId` names the chat being cancelled — its own phase, its own
		// session. Omitted = the focused session (surface-less legacy callers).
		this.setPhaseForSession("resumable", undefined, sessionId)
		await this.taskControl.cancelTask(sessionId)
	}

	async cancelBackgroundCommand(): Promise<void> {
		stubWarn("cancelBackgroundCommand")
	}

	/**
	 * "Proceed While Running": detach every in-flight foreground terminal
	 * command. Each pending run_commands call returns its partial output plus
	 * the log file path the remaining output is redirected to, and the agent
	 * turn continues while the commands keep running in their terminals.
	 */
	async proceedWhileRunningCommand(): Promise<void> {
		const detached = this.foregroundCommands.proceedWhileRunning()
		if (detached === 0) {
			Logger.warn("[SdkController] proceedWhileRunningCommand: No foreground command is running")
		}
	}

	async cancelQueuedPrompt(promptId: string): Promise<void> {
		const trimmedPromptId = promptId.trim()
		if (!trimmedPromptId) {
			Logger.warn("[SdkController] cancelQueuedPrompt: Missing prompt id")
			return
		}

		const activeSession = this.sessions.getActiveSession()
		if (!activeSession) {
			Logger.warn("[SdkController] cancelQueuedPrompt: No active session")
			return
		}

		const result = await activeSession.sdkHost.pendingPrompts("delete", {
			sessionId: activeSession.sessionId,
			promptId: trimmedPromptId,
		})
		if (!result.removed) {
			Logger.warn(`[SdkController] cancelQueuedPrompt: Prompt not found: ${trimmedPromptId}`)
		}
		await this.postStateToWebview()
	}

	/**
	 * Manually compact (condense) the active task's conversation. Triggered by
	 * the compact button and the `/compact` (alias `/smol`) slash command.
	 * Mirrors the CLI's `/compact` local command: runs an SDK manual compaction
	 * and persists the compaction sidecar so the model's working context is
	 * reduced on the next turn and later resumes.
	 */
	async compactTask(): Promise<void> {
		await this.compaction.compactTask()
	}

	async clearTask(options: { stopActiveSession?: boolean } = {}): Promise<void> {
		this.pendingClineAuthRetryPrompt = undefined
		// No active task — UI returns to idle (input enabled, no buttons/thinking).
		this.turnStateTracker.set("idle")
		// Cline Cubed: `stopActiveSession: false` clears the task VIEW without ending anyone's
		// session — for callers that only need a clean view (the external startNewTask API),
		// where bare clearTask killed whichever chat the user had focused.
		await this.taskControl.clearTask(options)
		await this.postStateToWebview()
	}

	async handleTaskCreation(prompt: string): Promise<void> {
		await this.initTask(prompt)
	}

	/**
	 * Send a follow-up message to the active session.
	 * This is the "askResponse" equivalent — continues the conversation.
	 *
	 * Like initTask(), this is fire-and-forget: core.send() blocks until
	 * the agent turn completes, but events stream in real-time via the
	 * subscription. We do NOT await the send — the gRPC handler needs to
	 * return immediately so the webview stays responsive.
	 */
	async askResponse(prompt?: string, images?: string[], files?: string[], targetSessionId?: string): Promise<void> {
		if (this.pendingClineAuthRetryPrompt !== undefined && this.task?.taskState?.askResponse === "yesButtonClicked") {
			const retryPrompt = this.pendingClineAuthRetryPrompt
			this.pendingClineAuthRetryPrompt = undefined
			await this.initTask(retryPrompt, images, files)
			return
		}

		// Cline Cubed: a response belongs to the chat that asked, so phase + state updates are
		// scoped to that session rather than to whichever chat is focused.
		const phaseTracker = this.getTurnStateTrackerFor(targetSessionId)
		const turnStateBefore = phaseTracker.get()

		// Answering an ask / continuing after completion / resuming a cancelled task all kick off a
		// new agent turn — move the authoritative phase to "streaming" so the footer shows
		// Thinking + Cancel (and not the stale resumable/completed/awaiting_followup buttons or the
		// scroll-arrow default). Mirrors initTask(). The webview gates turnState by seq, and the
		// session-event coordinator will set the terminal phase (completed/awaiting_followup/error)
		// when this turn ends.
		this.setPhaseForSession("streaming", undefined, targetSessionId)
		// Clear the previous turn's completion signal so this new turn's phase is computed fresh —
		// on the TARGET session's own translator, not the focused chat's.
		this.getTranslatorFor(targetSessionId).clearTurnOutcome()
		// The webview only learns the phase through a full state post. Without one here it would
		// keep the stale terminal phase (and hide the thinking indicator) until the first session
		// event of the new turn posts state — a visible delay after every follow-up/approval.
		this.postStateToWebview(targetSessionId).catch((error) => {
			Logger.error("[SdkController] Failed to post state after askResponse phase change:", error)
		})
		const askingTask = targetSessionId ? this.taskProxies.get(targetSessionId) : this.task
		await this.followups.askResponse(
			prompt,
			images,
			files,
			askingTask?.taskState?.askResponse,
			turnStateBefore.phase,
			targetSessionId,
		)
	}

	async editMessageAndRegenerate(input: {
		messageTs: number
		text: string
		images?: string[]
		files?: string[]
		restoreWorkspace?: boolean
	}): Promise<void> {
		const editedText = input.text.trim()
		if (!editedText && (input.images?.length ?? 0) === 0 && (input.files?.length ?? 0) === 0) {
			throw new Error("Edited message cannot be empty")
		}

		const activeSession = this.sessions.getActiveSession()
		const currentTask = this.task
		if (!currentTask) {
			throw new Error("No active task to edit")
		}

		const clineMessages = currentTask.messageStateHandler.getClineMessages()
		const targetIndex = clineMessages.findIndex((message) => message.ts === input.messageTs)
		if (targetIndex === -1) {
			throw new Error("Message to edit was not found")
		}
		const targetMessage = clineMessages[targetIndex]
		if (targetMessage.type !== "say" || (targetMessage.say !== "task" && targetMessage.say !== "user_feedback")) {
			throw new Error("Only user messages can be edited")
		}

		const userOrdinal = clineMessages
			.slice(0, targetIndex + 1)
			.filter((message) => message.type === "say" && (message.say === "task" || message.say === "user_feedback")).length
		const canRestoreWorkspace = getCheckpointRunCountForMessage(clineMessages, targetIndex) !== undefined
		const sourceSessionId = activeSession?.sessionId ?? currentTask.taskId
		let sdkMessages: SdkUserMessage[]
		let tempHost: VscodeSessionHost | undefined
		const sessionHost = activeSession?.sdkHost ?? (tempHost = await this.createRemoteConfigAwareSessionHost())
		try {
			sdkMessages = (await sessionHost.readMessages(sourceSessionId)) as SdkUserMessage[]
			const sdkTargetIndex = findSdkUserMessageIndexByOrdinal(sdkMessages, userOrdinal)
			if (sdkTargetIndex === -1) {
				throw new Error("Could not map edited message to persisted conversation history")
			}
			const checkpointRunCount = getSdkCheckpointRunCountForMessageIndex(sdkMessages, sdkTargetIndex)

			const initialMessages = sdkMessages.slice(0, sdkTargetIndex) as Parameters<
				VscodeSessionHost["start"]
			>[0]["initialMessages"]
			const firstUserMessage = sdkMessages.find(
				(message) => message.role === "user" && !!extractSdkUserText(message) && !isSyntheticSdkUserMessage(message),
			)
			const historyTitle =
				userOrdinal === 1
					? editedText
					: extractSdkUserText(firstUserMessage ?? {}) || clineMessages[0]?.text || editedText
			const fallbackCwd = await this.getWorkspaceRoot()
			const [sessionRecord, historyItem] = await Promise.all([
				sessionHost.get(sourceSessionId).catch(() => undefined),
				this.taskHistory.findHistoryItem(currentTask.taskId).catch(() => undefined),
			])
			const cwd =
				sessionRecord?.cwd?.trim() ||
				sessionRecord?.workspaceRoot?.trim() ||
				historyItem?.cwdOnTaskInitialization?.trim() ||
				fallbackCwd
			const mode = this.stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"
			const config = await this.sessionConfigBuilder.build({ cwd, mode, prompt: historyTitle })
			if (usesClineAccountAuth(config.providerId) && !config.apiKey) {
				this.emitClineAuthErrorWithTelemetry(editedText)
				return
			}

			const resolvedPrompt = await this.resolveContextMentions(editedText)
			const startInput = {
				...buildStartSessionInput(config, { prompt: historyTitle, cwd, mode }),
				initialMessages,
				sessionMetadata: {
					title: historyTitle,
					modelId: config.modelId,
					...(checkpointRunCount
						? { checkpoint: createRestoredCheckpointMetadata(sessionRecord, checkpointRunCount) }
						: {}),
				},
			}

			if (input.restoreWorkspace) {
				if (activeSession?.isRunning) {
					throw new Error("Wait for the current run to finish before restoring workspace changes")
				}
				if (!canRestoreWorkspace || checkpointRunCount === undefined) {
					throw new Error("Workspace restore is only available for messages that started an agent run")
				}
				await sessionHost.restore({
					sessionId: sourceSessionId,
					checkpointRunCount,
					cwd,
					restore: {
						messages: false,
						workspace: true,
						omitCheckpointMessageFromSession: true,
					},
				})
			}

			// The edit supersedes the old session — settle any pending tool
			// approval / ask_question exactly like cancelTask does. Without this,
			// the old run stays suspended forever on a promise nothing can
			// resolve, and the stale parked resolver intercepts later responses.
			// Scoped to the session being replaced; other chats' pendings stay live.
			this.interactions.clearPending("Superseded by an edited message", sourceSessionId)

			const { startResult, sdkHost } = await this.sessions.startNewSession(startInput)

			this.turnStateTracker.set("streaming")
			this.messageTranslatorState.clearTurnOutcome()
			this.resetMessageTranslatorAndFence()

			const task = createTaskProxy(
				startResult.sessionId,
				(text?: string, images?: string[], files?: string[], proxySessionId?: string) =>
					this.askResponse(text, images, files, proxySessionId ?? startResult.sessionId),
				(proxySessionId?: string) => this.cancelTask(proxySessionId ?? startResult.sessionId),
			)
			this.task = task

			const newHistoryItem = createHistoryItemFromSession(startResult.sessionId, historyTitle, config.modelId, cwd)
			await this.taskHistory.updateTaskHistoryItem(newHistoryItem)

			const visibleMessages = clineMessages.slice(0, targetIndex)
			if (visibleMessages.length > 0) {
				task.messageStateHandler.addMessages(visibleMessages)
			}
			task.messageStateHandler.addMessages([
				{
					ts: Date.now(),
					type: "say",
					say: userOrdinal === 1 ? "task" : "user_feedback",
					text: editedText,
					images: input.images,
					files: input.files,
					partial: false,
				},
			])
			await this.postStateToWebview()

			this.sessions.fireAndForgetSend(sdkHost, startResult.sessionId, resolvedPrompt, input.images, input.files)
		} finally {
			await tempHost?.dispose("editMessageAndRegenerate")
		}
	}

	async restoreCheckpoint(input: { checkpointRunCount: number; restoreType: ClineCheckpointRestore }): Promise<void> {
		const restoreMessages = input.restoreType === "task" || input.restoreType === "taskAndWorkspace"
		const restoreWorkspace = input.restoreType === "workspace" || input.restoreType === "taskAndWorkspace"
		const checkpointRunCount = Number(input.checkpointRunCount)
		if (!Number.isInteger(checkpointRunCount) || checkpointRunCount < 1) {
			throw new Error("checkpointRunCount must be a positive integer")
		}

		const activeSession = this.sessions.getActiveSession()
		const currentTask = this.task
		if (!activeSession || !currentTask) {
			throw new Error("No active task to restore")
		}
		if (activeSession.isRunning) {
			await this.cancelTask(activeSession.sessionId)
		}

		const currentMessages = currentTask.messageStateHandler.getClineMessages()
		const target = restoreMessages ? findVisibleCheckpointUserMessageByRun(currentMessages, checkpointRunCount) : undefined
		if (restoreMessages && !target) {
			throw new Error(`Could not find user message for checkpoint run ${checkpointRunCount}`)
		}

		const cwd = await this.getWorkspaceRoot()
		const mode = this.stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"
		const firstUserMessage = currentMessages.find(isVisibleCheckpointUserMessage)
		const restoredText = target?.message.text ?? ""
		const historyTitle = checkpointRunCount === 1 ? restoredText : firstUserMessage?.text || restoredText
		const config = restoreMessages ? await this.sessionConfigBuilder.build({ cwd, mode, prompt: historyTitle }) : undefined
		if (config && usesClineAccountAuth(config.providerId) && !config.apiKey) {
			this.emitClineAuthErrorWithTelemetry(restoredText)
			return
		}

		const startInput = config
			? {
					...buildStartSessionInput(config, { prompt: historyTitle, cwd, mode }),
					sessionMetadata: {
						title: historyTitle,
						modelId: config.modelId,
					},
				}
			: undefined

		const restored = await this.sessions.restoreActiveSession({
			sessionId: activeSession.sessionId,
			checkpointRunCount,
			cwd,
			restore: {
				messages: restoreMessages,
				workspace: restoreWorkspace,
				omitCheckpointMessageFromSession: true,
			},
			...(startInput ? { start: startInput } : {}),
		})

		if (!restoreMessages) {
			await this.postStateToWebview()
			return
		}

		if (!restored.sessionId || !restored.startResult || !target) {
			throw new Error("Checkpoint restore did not return a new session")
		}

		this.turnStateTracker.set("idle")
		this.messageTranslatorState.clearTurnOutcome()
		this.resetMessageTranslatorAndFence()

		const task = createTaskProxy(
			restored.sessionId,
			(text?: string, images?: string[], files?: string[], proxySessionId?: string) =>
				this.askResponse(text, images, files, proxySessionId ?? restored.sessionId),
			(proxySessionId?: string) => this.cancelTask(proxySessionId ?? restored.sessionId),
		)
		this.task = task

		const newHistoryItem = createHistoryItemFromSession(restored.sessionId, historyTitle, config?.modelId ?? "", cwd)
		await this.taskHistory.updateTaskHistoryItem(newHistoryItem)

		const visibleMessages = currentMessages.slice(0, target.index)
		if (visibleMessages.length > 0) {
			this.messages.replaceMessages(visibleMessages)
		}

		this.checkpointRestoreInput = {
			text: restoredText,
			images: target.message.images ?? [],
			files: target.message.files ?? [],
			sessionId: restored.sessionId,
		}
		await this.postStateToWebview()
	}

	/**
	 * Diffs the latest checkpoint — snapshotted when the user's last message
	 * started a run — against the current working tree. Returns undefined when
	 * no checkpoint exists (e.g. the workspace is not a git repository).
	 * Throws when there is no task at all.
	 */
	private async computeLatestCheckpointChanges(): Promise<CompareCheckpointResult["diffs"] | undefined> {
		const activeSession = this.sessions.getActiveSession()
		const sessionId = activeSession?.sessionId ?? this.task?.taskId
		if (!sessionId) {
			throw new Error("No active task to show changes for")
		}
		// After a window reload the latest task is shown from history without a
		// live session, so fall back to a temporary host for the comparison.
		let tempHost: VscodeSessionHost | undefined
		const sessionHost = activeSession?.sdkHost ?? (tempHost = await this.createRemoteConfigAwareSessionHost())
		try {
			if (!sessionHost.compareCheckpoint) {
				throw new Error("This session host does not support checkpoint comparison")
			}

			const sessionRecord = await sessionHost.get(sessionId)
			const latestCheckpoint = readSessionCheckpointHistory(sessionRecord).reduce(
				(latest, entry) => (!latest || entry.runCount > latest.runCount ? entry : latest),
				undefined as ReturnType<typeof readSessionCheckpointHistory>[number] | undefined,
			)
			if (!latestCheckpoint) {
				return undefined
			}

			const cwd = sessionRecord?.cwd?.trim() || sessionRecord?.workspaceRoot?.trim() || (await this.getWorkspaceRoot())
			const { diffs } = await sessionHost.compareCheckpoint({
				sessionId,
				checkpointRunCount: latestCheckpoint.runCount,
				cwd,
			})
			return diffs
		} finally {
			await tempHost?.dispose("viewLatestCheckpointChanges")
		}
	}

	/**
	 * Gates the "View Changes" button on the completion row: the number of
	 * files changed since the latest checkpoint, or 0 when nothing can be
	 * compared (no task, no checkpoint, comparison failure).
	 */
	async getLatestCheckpointChangesCount(): Promise<number> {
		try {
			return (await this.computeLatestCheckpointChanges())?.length ?? 0
		} catch (error) {
			Logger.debug(`[SdkController] Failed to count latest checkpoint changes: ${error}`)
			return 0
		}
	}

	/**
	 * "View Changes" on the completion row: opens a multi-file diff of
	 * everything that changed between the latest checkpoint — snapshotted when
	 * the user's last message started this run — and the current working tree.
	 */
	async viewLatestCheckpointChanges(): Promise<void> {
		const diffs = await this.computeLatestCheckpointChanges()
		if (diffs === undefined) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "No checkpoint was taken for this task. Checkpoints require the workspace to be a git repository.",
			})
			return
		}
		if (diffs.length === 0) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "No file changes found since your last message.",
			})
			return
		}

		await HostProvider.diff.openMultiFileDiff({
			title: "Changes since your last message",
			diffs: diffs.map((diff) => ({
				filePath: diff.filePath,
				leftContent: diff.leftContent,
				rightContent: diff.rightContent,
			})),
		})
	}

	/**
	 * Show a task from history by loading its messages.
	 * This does NOT start inference — it just loads the task for viewing.
	 *
	 * IMPORTANT: We do NOT call clearTask() here because clearTask() sets
	 * this.task = undefined and may trigger async operations (session stop/dispose)
	 * that race with the new task proxy creation. If any of those async operations
	 * trigger postStateToWebview() while this.task is undefined, the webview
	 * receives a state with no currentTaskItem/clineMessages and flashes back
	 * to the welcome screen (S6-6/S6-23 fix).
	 *
	 * Instead, we:
	 * 1. Silently tear down the active session (unsubscribe + stop in background)
	 * 2. Create the new task proxy with loaded messages BEFORE any state push
	 * 3. Only then push state to the webview
	 *
	 * Delegates straight to the coordinator (including the history lookup) so
	 * the "latest selection wins" generation is allocated synchronously at the
	 * moment of the request — awaiting the lookup here first would let a
	 * stalled older request grab a NEWER generation than a later selection and
	 * replace it.
	 */
	async showTaskWithId(taskId: string): Promise<TaskResponse> {
		const historyItem = await this.taskControl.showTaskWithId(taskId)
		if (!historyItem) {
			throw new Error(`Task not found in history: ${taskId}`)
		}
		// Cline Cubed: carry the chat's own name into the header of the surface that just opened it.
		this.activeTaskCustomTitle = historyItem.title
		return historyItemToTaskResponse(historyItem)
	}

	// ---- Mode switching ----

	async togglePlanActMode(modeToSwitchTo: Mode, chatContent?: ChatContent): Promise<boolean> {
		return this.mode.togglePlanActMode(modeToSwitchTo, chatContent)
	}

	// ---- Telemetry ----

	async updateTelemetrySetting(telemetrySetting: TelemetrySetting): Promise<void> {
		setTelemetryOptOutGlobally(telemetrySetting === "disabled", { telemetry: this.sdkTelemetry.telemetry })
		// Mirror to StateManager for existing VS Code services during the transition.
		this.stateManager.setGlobalState("telemetrySetting", telemetrySetting)
		await this.postStateToWebview()
	}

	// ---- Auth callbacks ----

	async handleSignOut(): Promise<void> {
		const sessionProviderId = this.getSessionProviderId() ?? this.getActiveProviderId()
		// Capture before deauth nulls the auth info, so the per-org config cache
		// (which can hold enterprise secrets) is actually deleted on sign-out.
		const organizationId = this.authService.getActiveOrganizationId() ?? undefined
		await this.taskControl.cancelClineTaskOnSignOut(isClineManagedProvider(sessionProviderId))
		await this.authService.handleDeauth(LogoutReason.USER_INITIATED)
		// Invalidate BEFORE clearing: a refresh that already fetched under the
		// signed-in identity must not republish the policy (and re-create the
		// secret-bearing caches) after the clear. The clear itself runs under the
		// same publication lock refreshes use, so it cannot interleave either.
		this.remoteConfigRefreshCoordinator.invalidate()
		await clearSdkRemoteConfig(this, {
			workspacePath: await this.getRemoteConfigWorkspacePath(),
			organizationId,
		})
		await this.postStateToWebview()
	}

	async handleOcaSignOut(): Promise<void> {
		await this.ocaAuthService.handleDeauth(LogoutReason.USER_INITIATED)
		await this.postStateToWebview()
	}

	async handleAuthCallback(customToken: string, provider: string | null = null): Promise<void> {
		await this.authService.handleAuthCallback(customToken, provider ?? "cline")
		// Fetch remote config immediately after login so enterprise policies
		// (provider lockdown, MCP servers, OTel, etc.) are applied right away.
		await this.refreshRemoteConfig()
		await this.postStateToWebview()
	}

	async handleOcaAuthCallback(code: string, state: string): Promise<void> {
		await this.ocaAuthService.handleAuthCallback(code, state)
		await this.postStateToWebview()
	}

	// ---- Provider auth callbacks ----

	private persistProviderApiKeyFromState(provider: string): void {
		const providerId = parseProviderId(provider)
		const apiKey = this.providerConfigStore.read(providerId).apiKey

		if (!apiKey) {
			Logger.warn(`[SdkController] No API key found after ${provider} auth callback`)
			return
		}

		this.providerConfigStore.write(providerId, { apiKey })
	}

	async handleOpenRouterCallback(code: string): Promise<void> {
		await this.authService.handleOpenRouterCallback(code)
		this.persistProviderApiKeyFromState("openrouter")
		await this.postStateToWebview()
	}

	async handleRequestyCallback(code: string): Promise<void> {
		await this.authService.handleRequestyCallback(code)
		this.persistProviderApiKeyFromState("requesty")
		await this.postStateToWebview()
	}

	async handleHicapCallback(code: string): Promise<void> {
		await this.authService.handleHicapCallback(code)
		this.persistProviderApiKeyFromState("hicap")
		await this.postStateToWebview()
	}

	async getTaskHistory(request: GetTaskHistoryRequest): Promise<TaskHistoryArray> {
		const { favoritesOnly, currentWorkspaceOnly, searchQuery, sortBy } = request
		const limit = request.limit > 0 ? Math.min(request.limit, 100) : 50
		const offset = request.offset > 0 ? request.offset : 0
		const workspacePath = currentWorkspaceOnly ? await this.getWorkspaceRoot() : undefined
		const sessionHistory = await this.taskHistory.listHistory({
			hydrate: false,
			limit: limit + 1,
			offset,
		})

		let filteredTasks = sessionHistory.filter((item) => {
			const ts = dateStringToTimestamp(item.updatedAt ?? item.endedAt ?? item.startedAt)
			const task = metadataString(item.metadata, "title") ?? item.prompt ?? ""

			if (!ts || !task) {
				return false
			}

			const isFavorited =
				metadataBoolean(item.metadata, "isFavorited") ?? metadataBoolean(item.metadata, "is_favorited") ?? false
			if (favoritesOnly && !isFavorited) {
				return false
			}

			if (currentWorkspaceOnly && workspacePath) {
				const sessionWorkspacePath = item.cwd ?? item.workspaceRoot
				if (!sessionWorkspacePath || !arePathsEqual(sessionWorkspacePath, workspacePath)) {
					return false
				}
			}

			return true
		})

		if (searchQuery) {
			const query = searchQuery.toLowerCase()
			filteredTasks = filteredTasks.filter((item) => {
				const task = metadataString(item.metadata, "title") ?? item.prompt ?? ""
				return task.toLowerCase().includes(query)
			})
		}

		filteredTasks.sort((a, b) => {
			switch (sortBy) {
				case "oldest":
					return (
						dateStringToTimestamp(a.updatedAt ?? a.endedAt ?? a.startedAt) -
						dateStringToTimestamp(b.updatedAt ?? b.endedAt ?? b.startedAt)
					)
				case "mostExpensive":
					return (metadataNumber(b.metadata, "totalCost") ?? 0) - (metadataNumber(a.metadata, "totalCost") ?? 0)
				case "mostTokens":
					return (
						(metadataNumber(b.metadata, "tokensIn") ?? 0) +
						(metadataNumber(b.metadata, "tokensOut") ?? 0) +
						(metadataNumber(b.metadata, "cacheWrites") ?? 0) +
						(metadataNumber(b.metadata, "cacheReads") ?? 0) -
						((metadataNumber(a.metadata, "tokensIn") ?? 0) +
							(metadataNumber(a.metadata, "tokensOut") ?? 0) +
							(metadataNumber(a.metadata, "cacheWrites") ?? 0) +
							(metadataNumber(a.metadata, "cacheReads") ?? 0))
					)
				default:
					return (
						dateStringToTimestamp(b.updatedAt ?? b.endedAt ?? b.startedAt) -
						dateStringToTimestamp(a.updatedAt ?? a.endedAt ?? a.startedAt)
					)
			}
		})

		const hasMore = sessionHistory.length > limit
		const tasks = filteredTasks.slice(0, limit).map((item) => {
			const metadata = item.metadata
			return {
				id: item.sessionId,
				task: formatDisplayUserInput(metadataString(metadata, "title") ?? item.prompt ?? ""),
				ts: dateStringToTimestamp(item.updatedAt ?? item.endedAt ?? item.startedAt),
				isFavorited: metadataBoolean(metadata, "isFavorited") ?? metadataBoolean(metadata, "is_favorited") ?? false,
				size: metadataNumber(metadata, "size") ?? 0,
				totalCost: metadataNumber(metadata, "totalCost") ?? 0,
				tokensIn: metadataNumber(metadata, "tokensIn") ?? 0,
				tokensOut: metadataNumber(metadata, "tokensOut") ?? 0,
				cacheWrites: metadataNumber(metadata, "cacheWrites") ?? 0,
				cacheReads: metadataNumber(metadata, "cacheReads") ?? 0,
				modelId: item.model || metadataString(metadata, "modelId") || "",
				isLegacy:
					metadataBoolean(metadata, "legacyTask") === true ||
					metadataBoolean(metadata, "migratedFromLegacyTask") === true,
				// Cline Cubed: the chat's own name when it has been renamed; empty means it is
				// still shown by its first prompt.
				title: metadataString(metadata, "customTitle") ?? "",
			}
		})

		if (offset === 0 && !favoritesOnly && this.task?.taskId && !tasks.some((task) => task.id === this.task?.taskId)) {
			const taskMessage = this.task.messageStateHandler
				.getClineMessages()
				.find((message) => message.type === "say" && message.say === "task" && message.text)
			const matchesSearch = !searchQuery || taskMessage?.text?.toLowerCase().includes(searchQuery.toLowerCase())
			if (taskMessage?.text && matchesSearch) {
				tasks.unshift({
					id: this.task.taskId,
					task: formatDisplayUserInput(taskMessage.text),
					ts: taskMessage.ts || Date.now(),
					isFavorited: false,
					size: 0,
					totalCost: 0,
					tokensIn: 0,
					tokensOut: 0,
					cacheWrites: 0,
					cacheReads: 0,
					modelId: this.task.api?.getModel?.().id ?? "",
					isLegacy: false,
					// Cline Cubed: this branch injects the in-flight task, which by its own guard
					// is NOT yet in the history list — so it cannot have been renamed. Empty means
					// it shows by its first prompt.
					title: "",
				})
			}
		}

		return TaskHistoryArray.create({ tasks: tasks.slice(0, limit), hasMore })
	}

	async exportTaskWithId(id: string): Promise<void> {
		const taskDirPath = await this.taskHistory.getTaskDirPath(id)
		if (!taskDirPath) {
			throw new Error(`Task not found in history: ${id}`)
		}

		await fs.access(taskDirPath)
		Logger.log(`[EXPORT] Opening task directory: ${taskDirPath}`)
		const open = (await import("open")).default
		await open(taskDirPath)
	}

	async deleteTaskFromState(id: string): Promise<HistoryItem[]> {
		return this.taskHistory.deleteTaskFromState(id)
	}

	async deleteAllTaskHistory(): Promise<DeleteAllTaskHistoryCount> {
		await this.clearTask()

		const taskHistory = await this.taskHistory.listHistory({ hydrate: false })
		const totalTasks = taskHistory.length

		const userChoice = (
			await HostProvider.window.showMessage(
				ShowMessageRequest.create({
					type: ShowMessageType.WARNING,
					message: "What would you like to delete?",
					options: {
						modal: true,
						items: ["Delete All Except Favorites", "Delete Everything"],
					},
				}),
			)
		).selectedOption

		if (userChoice === undefined) {
			return DeleteAllTaskHistoryCount.create({ tasksDeleted: 0 })
		}

		if (userChoice === "Delete All Except Favorites") {
			const hasFavoritedTasks = taskHistory.some(
				(task) =>
					metadataBoolean(task.metadata, "isFavorited") ?? metadataBoolean(task.metadata, "is_favorited") ?? false,
			)

			if (hasFavoritedTasks) {
				const tasksDeleted = await this.taskHistory.deleteAllTaskHistory({
					preserveFavorites: true,
				})
				await this.postStateToWebview()
				return DeleteAllTaskHistoryCount.create({ tasksDeleted })
			}

			const answer = (
				await HostProvider.window.showMessage({
					type: ShowMessageType.WARNING,
					message: "No favorited tasks found. Would you like to delete all tasks anyway?",
					options: {
						modal: true,
						items: ["Delete All Tasks"],
					},
				})
			).selectedOption

			if (answer === undefined) {
				return DeleteAllTaskHistoryCount.create({ tasksDeleted: 0 })
			}
		}

		const tasksDeleted = await this.taskHistory.deleteAllTaskHistory()
		await this.postStateToWebview()
		return DeleteAllTaskHistoryCount.create({
			tasksDeleted: tasksDeleted || totalTasks,
		})
	}

	async updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]> {
		return this.taskHistory.updateTaskHistory(item)
	}

	/**
	 * Cline Cubed: rename a chat. A blank title clears the name and restores the first prompt.
	 * Delegated straight to the history layer, whose `setTaskTitle` is the only writer that does
	 * not also rewrite the stored prompt.
	 */
	async setTaskTitle(taskId: string, title: string): Promise<void> {
		await this.taskHistory.setTaskTitle(taskId, title)
		if (taskId === this.task?.taskId) {
			const trimmed = title.trim()
			this.activeTaskCustomTitle = trimmed ? trimmed : undefined
		}
		// Anything outside a webview that carries this chat's name in its own chrome — an editor
		// tab title — hears about it here and re-resolves the name for itself.
		notifyChatTitleChanged(taskId)
		await this.postStateToWebview()
	}

	/**
	 * Cline Cubed: a chat's displayed name — its own name if it has been renamed, otherwise its
	 * first prompt. `undefined` when the chat is not in history (a brand-new chat that has not
	 * been saved yet), which callers render as their own default.
	 */
	async getChatDisplayTitle(taskId: string): Promise<string | undefined> {
		try {
			const item = await this.taskHistory.findHistoryItem(taskId)
			return item ? chatDisplayTitle(item) : undefined
		} catch {
			return undefined
		}
	}

	/** Cline Cubed: the active chat's own name for the state broadcast; undefined when unnamed. */
	getActiveTaskTitle(): string | undefined {
		return this.task?.taskId ? this.activeTaskCustomTitle : undefined
	}

	async toggleTaskFavorite(taskId: string, isFavorited: boolean): Promise<void> {
		const historyItem = await this.taskHistory.findHistoryItem(taskId)
		if (!historyItem) {
			Logger.log(`[toggleTaskFavorite] Task not found in history: ${taskId}`)
			return
		}

		await this.taskHistory.updateTaskHistory({
			...historyItem,
			isFavorited,
		})
		await this.postStateToWebview()
	}

	// ---- Background command state ----

	updateBackgroundCommandState(running: boolean, taskId?: string): void {
		this.backgroundCommandRunning = running
		this.backgroundCommandTaskId = taskId
	}

	// ---- State management ----

	/**
	 * Request a webview state update.
	 *
	 * Callers fire this very frequently (notably the session event coordinator,
	 * once per streamed message/turn boundary), and each rebuild walks the full
	 * task history. StatePostDebouncer coalesces bursts into a single trailing
	 * rebuild to avoid hammering the extension host. The returned promise
	 * resolves once a snapshot reflecting this request has been shipped, or
	 * rejects if that rebuild failed.
	 */
	/**
	 * Cline Cubed: the turn-phase tracker for a given session (undefined = focused).
	 * Each live session gets its own tracker sharing the single id/seq/epoch authority.
	 */
	private getTurnStateTrackerFor(sessionId?: string): TurnStateTracker {
		if (!sessionId) {
			return this.turnStateTracker
		}
		let tracker = this.turnStateTrackers.get(sessionId)
		if (!tracker) {
			tracker = new TurnStateTracker(this.messageTranslatorState.getMinter())
			this.turnStateTrackers.set(sessionId, tracker)
		}
		return tracker
	}

	postStateToWebview(sessionId?: string): Promise<void> {
		if (this.isDisposed) {
			return Promise.resolve()
		}
		return this.statePostDebouncer.post(sessionId)
	}

	/**
	 * Build the current ExtensionState for a session and push it to the webview immediately.
	 * `sessionId` targets that session's own snapshot (V7); undefined builds the focused one.
	 */
	private async flushStateToWebview(sessionId?: string): Promise<void> {
		// Import dynamically to avoid circular deps
		const { sendStateUpdate } = await import("@core/controller/state/subscribeToState")
		const state = await this.getStateToPostToWebview(sessionId)
		// Cline Cubed: every surface is served a snapshot for the session IT is showing, so an
		// update for one chat never blanks or overwrites another.
		await sendStateUpdate(state, sessionId, (surfaceSessionId) => this.getStateToPostToWebview(surfaceSessionId))
	}

	/**
	 * Reset the message translator's streaming state AND bump the conversation/replica fence
	 * (epoch). Called at every conversation boundary (task start/clear, history open, reinit,
	 * mode rebuild, new-session follow-up). Bumping the epoch BEFORE the new state is pushed
	 * means any straggler message/state from the previous task or render carries an older epoch
	 * and is dropped by the webview. Order matters: bump synchronously here, before any await.
	 *
	 * Cline Cubed: `sessionId` resets that session's OWN translator (chats run side by side, so
	 * a background chat's boundary must not clear the focused chat's streaming state); omitted
	 * resets the focused translator, exactly as before.
	 */
	resetMessageTranslatorAndFence(sessionId?: string): void {
		this.getTranslatorFor(sessionId).reset()
		this.messageTranslatorState.getMinter().bumpEpoch()
	}

	/**
	 * Cline Cubed: set a session's authoritative turn phase. Writes the session's own tracker,
	 * and — when that session is also the focused one — mirrors the focused tracker, which is
	 * what identity-less consumers (standalone host, CLI) read.
	 */
	private setPhaseForSession(phase: TurnPhase, anchorTs?: number, sessionId?: string): void {
		this.getTurnStateTrackerFor(sessionId).set(phase, anchorTs)
		if (sessionId && this.task?.taskId === sessionId) {
			this.turnStateTracker.set(phase, anchorTs)
		}
	}

	/**
	 * Cline Cubed: a resume was forced onto a NEW SDK session id. Re-key the bindings that still
	 * carry the previous id: alias the proxy under the new id (the old entry stays, so responses
	 * stamped with the history id still resolve to the same proxy) and move the chat-surface
	 * registry binding so state and transcript keep flowing to the surface showing this chat.
	 */
	private handleSessionIdChanged(previousSessionId: string, newSessionId: string, task: TaskProxy): void {
		this.taskProxies.set(newSessionId, task)
		const surfaceId = chatSurfaceForSession(previousSessionId)
		if (surfaceId) {
			bindChatSurfaceToSession(surfaceId, newSessionId)
		}
	}

	async getStateToPostToWebview(sessionId?: string): Promise<ExtensionState> {
		// Build the base ExtensionState from StateManager, then layer the SDK's
		// task history on top. `sessionId` targets that session's own task proxy and turn
		// state; undefined builds the focused chat's snapshot. STRICT: a named session that has
		// no resident proxy builds with NO task — never the focused one, whose conversation
		// belongs to a different chat.
		const task = sessionId ? this.taskProxies.get(sessionId) : this.task
		try {
			syncTelemetrySettingFromSharedGlobalSettings(this.stateManager)
			const { getStateToPostToWebview: buildBaseState } = await import("@core/controller/state/getStateToPostToWebview")
			const state = await buildBaseState({
				task,
				stateManager: this.stateManager,
				mcpHub: this.mcpHub,
				// The active chat's own name — meaningful only when THIS snapshot is the focused
				// chat's (activeTaskCustomTitle tracks the focused task alone). A per-session
				// snapshot for another chat gets its name from currentTaskItem.title instead.
				...(!sessionId || sessionId === this.task?.taskId ? { getActiveTaskTitle: () => this.getActiveTaskTitle() } : {}),
				checkpointRestoreInput: this.checkpointRestoreInput,
				backgroundCommandRunning: this.backgroundCommandRunning,
				backgroundCommandTaskId: this.backgroundCommandTaskId,
				foregroundCommandRunning: this.foregroundCommands.isRunning,
				isRemoteConfigAvailable: this.isRemoteConfigAvailable,
				currentRemoteConfigRevision: this.currentRemoteConfigRevision,
				// Without this the webview always receives workspaceRoots: [] on the
				// SDK path (classic Controller exposes a public workspaceManager;
				// SdkController builds one lazily). The task-header working-directory
				// badge and anything else keyed on workspaceRoots depend on it.
				workspaceManager: await this.ensureWorkspaceManager(),
			})
			const sdkTaskHistory = (await this.taskHistory.listHistory({ limit: 100, hydrate: false }))
				.map(sessionHistoryRecordToHistoryItem)
				.filter((item) => item.ts && item.task)
				.sort((a, b) => b.ts - a.ts)
			const legacyTaskHistory = state.taskHistory ?? []
			const mergedTaskHistoryById = new Map<string, HistoryItem>()

			// Keep the SDK records authoritative for migrated/new tasks, but append
			// legacy persisted history so pre-migration tasks still appear in the UI.
			for (const item of legacyTaskHistory) {
				mergedTaskHistoryById.set(item.id, item)
			}
			for (const item of sdkTaskHistory) {
				mergedTaskHistoryById.set(item.id, item)
			}

			// A just-started task may not be visible in SDK persisted history yet (the
			// history adapter can lag behind the active in-memory TaskProxy). Classic
			// state included the current task immediately, and the testing platform
			// asserts that taskHistory reflects newTask before the model turn completes.
			if (task?.taskId && !mergedTaskHistoryById.has(task.taskId)) {
				const taskMessage = task.messageStateHandler
					.getClineMessages()
					.find((message) => message.type === "say" && message.say === "task" && message.text)
				if (taskMessage?.text) {
					mergedTaskHistoryById.set(task.taskId, {
						id: task.taskId,
						ts: taskMessage.ts || Date.now(),
						task: taskMessage.text,
						tokensIn: 0,
						tokensOut: 0,
						cacheWrites: 0,
						cacheReads: 0,
						totalCost: 0,
						modelId: task.api?.getModel?.().id,
						cwdOnTaskInitialization: await this.getWorkspaceRoot(),
					})
				}
			}

			const processedTaskHistory = Array.from(mergedTaskHistoryById.values())
				.filter((item) => item.ts && item.task)
				.sort((a, b) => b.ts - a.ts)
				.slice(0, 100)

			let queuedPrompts: ExtensionState["queuedPrompts"] = []
			// V7: pending prompts belong to the session whose snapshot is being built.
			const promptSession = sessionId ? this.sessions.getLiveSession(sessionId) : this.sessions.getActiveSession()
			if (promptSession) {
				try {
					queuedPrompts = await promptSession.sdkHost.pendingPrompts("list", { sessionId: promptSession.sessionId })
				} catch (error) {
					Logger.error("[SdkController] Failed to list pending prompts for webview state:", error)
				}
			}

			// Stamp the snapshot with the current epoch and a fresh monotonic version, sampled
			// from the SAME counter that stamps messages. This lets the webview ignore stale
			// out-of-order state pushes and fence traffic from a previous task/render. Sampled
			// synchronously here (no await between sampling and return).
			const minter = this.messageTranslatorState.getMinter()
			return {
				...state,
				currentTaskItem: task?.taskId ? processedTaskHistory.find((item) => item.id === task?.taskId) : undefined,
				taskHistory: processedTaskHistory,
				// V7: the snapshot carries the SESSION's own turn phase.
				turnState: this.getTurnStateTrackerFor(sessionId).get(),
				queuedPrompts,
				stateVersion: minter.nextSeq(),
				epoch: minter.epoch,
			}
		} catch (error) {
			Logger.error("[SdkController] Failed to get state for webview:", error)
			throw error
		}
	}

	// ---- Terminal settings ----

	/**
	 * Apply the user's terminal settings from StateManager to a terminal manager.
	 * Called once when the lazy terminal manager is first created, and can be
	 * called again when settings change at runtime.
	 */
	applyTerminalSettings(terminalManager: VscodeTerminalManager): void {
		const shellIntegrationTimeout = this.stateManager.getGlobalSettingsKey("shellIntegrationTimeout")
		if (shellIntegrationTimeout !== undefined) {
			terminalManager.setShellIntegrationTimeout(Number(shellIntegrationTimeout))
		}

		const terminalReuseEnabled = this.stateManager.getGlobalStateKey("terminalReuseEnabled")
		if (terminalReuseEnabled !== undefined) {
			terminalManager.setTerminalReuseEnabled(!!terminalReuseEnabled)
		}

		const defaultTerminalProfile = this.stateManager.getGlobalSettingsKey("defaultTerminalProfile")
		if (defaultTerminalProfile !== undefined && defaultTerminalProfile !== "") {
			terminalManager.setDefaultTerminalProfile(String(defaultTerminalProfile))
		}

		Logger.log(
			`[SdkController] Applied terminal settings: profile=${defaultTerminalProfile ?? "default"}, ` +
				`timeout=${shellIntegrationTimeout ?? 4000}, reuse=${terminalReuseEnabled ?? true}`,
		)
	}

	/**
	 * Get the terminal manager instance (if created).
	 * Used by updateSettings handlers to apply runtime changes.
	 */
	get terminalManager(): VscodeTerminalManager | undefined {
		return this._terminalManager
	}

	// ---- Workspace (kept from classic) ----

	private _workspaceManager?: WorkspaceRootManager
	private _workspaceManagerPathsKey?: string

	async ensureWorkspaceManager(): Promise<WorkspaceRootManager | undefined> {
		try {
			const { paths } = await HostProvider.workspace.getWorkspacePaths({})
			// When no workspace folder is open, fall back to the active session's
			// working directory (if known) or the shared chat workspace, the same
			// root getWorkspaceRoot() gives sessions. The legacy Controller always
			// seeded its manager with a fallback root (setupWorkspaceManager →
			// getCwd(getDesktopDir())), so @-mention file search kept working in
			// an empty window; returning undefined here instead made searchFiles
			// emit task.mention_failed (workspace_unavailable) with zero results.
			const validPaths = resolveWorkspaceManagerPaths(
				paths,
				this.lastKnownWorkspaceRoot ?? (await this.getNoWorkspaceFallback()),
			)
			if (validPaths.length === 0) {
				return undefined
			}
			// Rebuild only when the set of workspace folders changes
			const pathsKey = JSON.stringify(validPaths)
			if (!this._workspaceManager || this._workspaceManagerPathsKey !== pathsKey) {
				this._workspaceManager = await WorkspaceRootManager.fromPaths(validPaths)
				this._workspaceManagerPathsKey = pathsKey
			}
			return this._workspaceManager
		} catch (error) {
			Logger.warn("[SdkController] Failed to build workspace manager:", error)
			return undefined
		}
	}
}
