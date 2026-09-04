import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import { combineHookSequences } from "@shared/combineHookSequences"
import { getApiMetrics, getLastApiReqTotalTokens } from "@shared/getApiMetrics"
import { chatDisplayTitle } from "@shared/HistoryItem"
import { BooleanRequest, StringRequest } from "@shared/proto/cline/common"
import { useCallback, useEffect, useMemo, useRef } from "react"
import { useMount } from "react-use"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useShowNavbar } from "@/context/PlatformContext"
import { useNormalizedApiConfiguration } from "@/hooks/useNormalizedApiConfiguration"
import { FileServiceClient, UiServiceClient } from "@/services/grpc-client"
import { Navbar } from "../menu/Navbar"
import AutoApproveBar from "./auto-approve-menu/AutoApproveBar"
// Import utilities and hooks from the new structure
import {
	ActionButtons,
	CHAT_CONSTANTS,
	ChatLayout,
	convertHtmlToMarkdown,
	filterVisibleMessages,
	groupLowStakesTools,
	groupMessages,
	InputSection,
	MessagesArea,
	QueuedPrompts,
	TaskSection,
	useChatState,
	useMessageHandlers,
	useScrollBehavior,
	WelcomeSection,
} from "./chat-view"
import {
	hasPendingMessageConfirmation,
	isPendingResponseUnconfirmed,
	withPendingUserMessage,
} from "./chat-view/utils/pendingResponse"

interface ChatViewProps {
	isHidden: boolean
	showHistoryView: () => void
}

// Use constants from the imported module
const MAX_IMAGES_AND_FILES_PER_MESSAGE = CHAT_CONSTANTS.MAX_IMAGES_AND_FILES_PER_MESSAGE
const QUICK_WINS_HISTORY_THRESHOLD = 3

const ChatView = ({ isHidden, showHistoryView }: ChatViewProps) => {
	const showNavbar = useShowNavbar()
	const {
		clineMessages: messages,
		taskHistory,
		telemetrySetting,
		mode,
		userInfo,
		hooksEnabled,
		checkpointRestoreInput,
		queuedPrompts,
		turnState,
		apiConfiguration,
		conversationLoading,
		currentTaskItem,
		activeTaskTitle,
	} = useExtensionState()
	const isProdHostedApp = userInfo?.apiBaseUrl === "https://app.cline.bot"
	const shouldShowQuickWins = isProdHostedApp && (!taskHistory || taskHistory.length < QUICK_WINS_HISTORY_THRESHOLD)

	// Use custom hooks for state management
	const chatState = useChatState(messages)
	const {
		setInputValue,
		selectedImages,
		setSelectedImages,
		selectedFiles,
		setSelectedFiles,
		sendingDisabled,
		enableButtons,
		expandedRows,
		setExpandedRows,
		pendingUserMessage,
		setPendingUserMessage,
		pendingResponse,
		setPendingResponse,
		textAreaRef,
	} = chatState

	const displayMessages = useMemo(() => withPendingUserMessage(messages, pendingUserMessage), [messages, pendingUserMessage])

	useEffect(() => {
		if (pendingUserMessage && hasPendingMessageConfirmation(messages, pendingUserMessage)) {
			setPendingUserMessage((current) => (current === pendingUserMessage ? undefined : current))
		}
	}, [messages, pendingUserMessage, setPendingUserMessage])

	useEffect(() => {
		if (!pendingResponse || isPendingResponseUnconfirmed(pendingResponse, turnState, messages.length)) {
			return
		}
		setPendingResponse((current) => (current?.id === pendingResponse.id ? undefined : current))
	}, [messages.length, pendingResponse, setPendingResponse, turnState])

	// The task is selected by WHAT IT IS first, position second. A transcript's first row is not
	// always the task: every turn opens with an api_req_started bookkeeping row (whose text is a
	// JSON blob), and a snapshot merge can land one at index 0 — rendering position-0 as "the
	// task" then displays that blob as the chat's name. Selecting by kind keeps the header on the
	// real first prompt whatever order a merge produced.
	//
	// The fallback to the first row is LOAD-BEARING, not politeness. `task` gates the whole
	// surface — falsy renders the Welcome home and unmounts the message list — and a replica can
	// legitimately hold rows with NO say:"task" row at all (a translator-built snapshot). A
	// kind-only selection turned such a mid-conversation chat into a home screen; falling back to
	// the first row keeps this selection total, exactly as broad as the position-only rule it
	// replaced.
	const task = useMemo(
		() => displayMessages.find((m) => m.type === "say" && m.say === "task") ?? displayMessages.at(0),
		[displayMessages],
	)
	const modifiedMessages = useMemo(() => {
		// The list drops ONLY index 0 — deliberately not "the task row". Whenever ordering puts
		// the task row elsewhere, the list is a place it still renders, and displays have relied
		// on that: excluding the found task row here instead once made a reopened chat's first
		// prompt vanish, because the header shows the task as one collapsible line and cannot be
		// its only home. In a scrambled ordering the task text may therefore show twice (header
		// and list); truthful duplication over lost content.
		const slicedMessages = displayMessages.slice(1)
		// Only combine hook sequences if hooks are enabled
		const withHooks = hooksEnabled ? combineHookSequences(slicedMessages) : slicedMessages
		return combineApiRequests(combineCommandSequences(withHooks))
	}, [displayMessages, hooksEnabled])
	// has to be after api_req_finished are all reduced into api_req_started messages
	const apiMetrics = useMemo(() => getApiMetrics(modifiedMessages), [modifiedMessages])

	const lastApiReqTotalTokens = useMemo(() => getLastApiReqTotalTokens(modifiedMessages) || undefined, [modifiedMessages])
	const lastAppliedCheckpointRestoreSessionId = useRef<string | undefined>(checkpointRestoreInput?.sessionId)

	useEffect(() => {
		if (!checkpointRestoreInput || checkpointRestoreInput.sessionId === lastAppliedCheckpointRestoreSessionId.current) {
			return
		}
		lastAppliedCheckpointRestoreSessionId.current = checkpointRestoreInput.sessionId
		setInputValue(checkpointRestoreInput.text)
		setSelectedImages(checkpointRestoreInput.images ?? [])
		setSelectedFiles(checkpointRestoreInput.files ?? [])
		setTimeout(() => {
			textAreaRef.current?.focus()
		}, 0)
	}, [checkpointRestoreInput, setInputValue, setSelectedImages, setSelectedFiles, textAreaRef])

	useEffect(() => {
		const handleCopy = async (e: ClipboardEvent) => {
			const targetElement = e.target as HTMLElement | null
			// If the copy event originated from an input or textarea,
			// let the default browser behavior handle it.
			if (
				targetElement &&
				(targetElement.tagName === "INPUT" || targetElement.tagName === "TEXTAREA" || targetElement.isContentEditable)
			) {
				return
			}

			if (window.getSelection) {
				const selection = window.getSelection()
				if (selection && selection.rangeCount > 0) {
					const range = selection.getRangeAt(0)
					const commonAncestor = range.commonAncestorContainer
					let textToCopy: string | null = null

					// Check if the selection is inside an element where plain text copy is preferred
					let currentElement =
						commonAncestor.nodeType === Node.ELEMENT_NODE
							? (commonAncestor as HTMLElement)
							: commonAncestor.parentElement
					let preferPlainTextCopy = false
					while (currentElement) {
						if (currentElement.tagName === "PRE" && currentElement.querySelector("code")) {
							preferPlainTextCopy = true
							break
						}
						// Check computed white-space style
						const computedStyle = window.getComputedStyle(currentElement)
						if (
							computedStyle.whiteSpace === "pre" ||
							computedStyle.whiteSpace === "pre-wrap" ||
							computedStyle.whiteSpace === "pre-line"
						) {
							// If the element itself or an ancestor has pre-like white-space,
							// and the selection is likely contained within it, prefer plain text.
							// This helps with elements like the TaskHeader's text display.
							preferPlainTextCopy = true
							break
						}

						// Stop searching if we reach a known chat message boundary or body
						if (
							currentElement.classList.contains("chat-row-assistant-message-container") ||
							currentElement.classList.contains("chat-row-user-message-container") ||
							currentElement.tagName === "BODY"
						) {
							break
						}
						currentElement = currentElement.parentElement
					}

					if (preferPlainTextCopy) {
						// For code blocks or elements with pre-formatted white-space, get plain text.
						textToCopy = selection.toString()
					} else {
						// For other content, use the existing HTML-to-Markdown conversion
						const clonedSelection = range.cloneContents()
						const div = document.createElement("div")
						div.appendChild(clonedSelection)
						const selectedHtml = div.innerHTML
						textToCopy = await convertHtmlToMarkdown(selectedHtml)
					}

					if (textToCopy !== null) {
						try {
							FileServiceClient.copyToClipboard(StringRequest.create({ value: textToCopy })).catch((err) => {
								console.error("Error copying to clipboard:", err)
							})
							e.preventDefault()
						} catch (error) {
							console.error("Error copying to clipboard:", error)
						}
					}
				}
			}
		}
		document.addEventListener("copy", handleCopy)

		return () => {
			document.removeEventListener("copy", handleCopy)
		}
	}, [])
	// Button state is now managed by useButtonState hook

	// handleFocusChange is already provided by chatState

	// Use message handlers hook
	const messageHandlers = useMessageHandlers(messages, chatState)

	const { selectedModelInfo } = useNormalizedApiConfiguration(mode)

	// Cline Cubed: allow image selection when Image Mode has a configured
	// model — the bridge describes images for a text-only Plan/Act model — OR
	// when the active Plan/Act model itself supports images.
	const imagesAllowedByImageMode = Boolean(apiConfiguration?.imageModeApiModelId)
	const imagesAllowed = imagesAllowedByImageMode || selectedModelInfo.supportsImages

	const selectFilesAndImages = useCallback(async () => {
		try {
			const response = await FileServiceClient.selectFiles(
				BooleanRequest.create({
					value: imagesAllowed,
				}),
			)
			if (
				response &&
				response.values1 &&
				response.values2 &&
				(response.values1.length > 0 || response.values2.length > 0)
			) {
				const currentTotal = selectedImages.length + selectedFiles.length
				const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - currentTotal

				if (availableSlots > 0) {
					// Prioritize images first
					const imagesToAdd = Math.min(response.values1.length, availableSlots)
					if (imagesToAdd > 0) {
						setSelectedImages((prevImages) => [...prevImages, ...response.values1.slice(0, imagesToAdd)])
					}

					// Use remaining slots for files
					const remainingSlots = availableSlots - imagesToAdd
					if (remainingSlots > 0) {
						setSelectedFiles((prevFiles) => [...prevFiles, ...response.values2.slice(0, remainingSlots)])
					}
				}
			}
		} catch (error) {
			console.error("Error selecting images & files:", error)
		}
	}, [imagesAllowed])

	const shouldDisableFilesAndImages = selectedImages.length + selectedFiles.length >= MAX_IMAGES_AND_FILES_PER_MESSAGE

	// Subscribe to show webview events from the backend
	useEffect(() => {
		const cleanup = UiServiceClient.subscribeToShowWebview(
			{},
			{
				onResponse: (event: any) => {
					// Only focus if not hidden and preserveEditorFocus is false
					if (!isHidden && !event.preserveEditorFocus) {
						textAreaRef.current?.focus()
					}
				},
				onError: (error: any) => {
					console.error("Error in showWebview subscription:", error)
				},
				onComplete: () => {
					console.log("showWebview subscription completed")
				},
			},
		)

		return cleanup
	}, [isHidden])

	// Set up addToInput subscription
	useEffect(() => {
		const cleanup = UiServiceClient.subscribeToAddToInput(
			{},
			{
				onResponse: (event: any) => {
					if (event.value) {
						setInputValue((prevValue) => {
							const newText = event.value
							const newTextWithNewline = newText + "\n"
							return prevValue ? `${prevValue}\n${newTextWithNewline}` : newTextWithNewline
						})
						// Add scroll to bottom after state update
						// Auto focus the input and start the cursor on a new line for easy typing
						setTimeout(() => {
							if (textAreaRef.current) {
								textAreaRef.current.scrollTop = textAreaRef.current.scrollHeight
								textAreaRef.current.focus()
							}
						}, 0)
					}
				},
				onError: (error: any) => {
					console.error("Error in addToInput subscription:", error)
				},
				onComplete: () => {
					console.log("addToInput subscription completed")
				},
			},
		)

		return cleanup
	}, [])

	useMount(() => {
		// NOTE: the vscode window needs to be focused for this to work
		textAreaRef.current?.focus()
	})

	useEffect(() => {
		const timer = setTimeout(() => {
			if (!isHidden && !sendingDisabled && !enableButtons) {
				textAreaRef.current?.focus()
			}
		}, 50)
		return () => {
			clearTimeout(timer)
		}
	}, [isHidden, sendingDisabled, enableButtons])

	const visibleMessages = useMemo(() => {
		return filterVisibleMessages(modifiedMessages)
	}, [modifiedMessages])

	const groupedMessages = useMemo(() => {
		return groupLowStakesTools(groupMessages(visibleMessages))
	}, [visibleMessages])

	// Use scroll behavior hook
	const scrollBehavior = useScrollBehavior(displayMessages, visibleMessages, groupedMessages, expandedRows, setExpandedRows)
	const { scrollToBottomSmooth, scrollToBottomAuto, disableAutoScrollRef } = scrollBehavior

	// When a prompt gets queued, the queue banner mounts (or grows) in the footer, which
	// shrinks the messages area and visually covers the bottom of the conversation. No new
	// chat row is added, so the list-length-based auto-scroll never fires — re-pin to the
	// bottom here so the latest content stays visible.
	const queuedPromptCount = queuedPrompts?.length ?? 0
	const taskTs = task?.ts
	const prevQueuedPromptCountRef = useRef(queuedPromptCount)
	const prevQueuedPromptTaskTsRef = useRef(taskTs)
	useEffect(() => {
		const previousCount = prevQueuedPromptCountRef.current
		const previousTaskTs = prevQueuedPromptTaskTsRef.current
		prevQueuedPromptCountRef.current = queuedPromptCount
		prevQueuedPromptTaskTsRef.current = taskTs
		// A task switch can grow the count without a send from this webview (the newly
		// displayed task may already have queued prompts) — don't hijack its scroll position.
		if (taskTs !== previousTaskTs || queuedPromptCount <= previousCount) {
			return
		}
		// Queueing is a deliberate send, so re-engage bottom pinning like handleSendMessage does.
		disableAutoScrollRef.current = false
		scrollToBottomSmooth()
		// Settle with an instant scroll once the footer's layout change has landed.
		setTimeout(() => {
			if (!disableAutoScrollRef.current) {
				scrollToBottomAuto()
			}
		}, 50)
	}, [queuedPromptCount, taskTs, scrollToBottomSmooth, scrollToBottomAuto, disableAutoScrollRef])

	const placeholderText = useMemo(() => {
		const text = task ? "Type a message..." : "Type your task here..."
		return text
	}, [task])

	return (
		<ChatLayout isHidden={isHidden}>
			<div className="flex flex-col flex-1 overflow-hidden">
				{showNavbar && <Navbar />}
				{task ? (
					<TaskSection
						apiMetrics={apiMetrics}
						lastApiReqTotalTokens={lastApiReqTotalTokens}
						messageHandlers={messageHandlers}
						selectedModelInfo={{
							supportsPromptCache: selectedModelInfo.supportsPromptCache,
							supportsImages: selectedModelInfo.supportsImages || false,
						}}
						task={task}
					/>
				) : conversationLoading ? (
					// Cline Cubed: this chat is real and its conversation is being loaded (a restore
					// after reload, or a slow open from History) — say so, with the chat's name.
					// Rendering WelcomeSection here is what showed the Home screen over a chat that
					// was seconds from arriving.
					<div className="flex flex-col items-center justify-center flex-1 gap-2 px-6 select-none">
						<span className="codicon codicon-loading codicon-modifier-spin" style={{ fontSize: 24 }} />
						{(() => {
							const loadingTitle = activeTaskTitle ?? (currentTaskItem ? chatDisplayTitle(currentTaskItem) : "")
							return loadingTitle ? (
								<div className="ph-no-capture text-base font-medium text-center whitespace-nowrap overflow-hidden text-ellipsis max-w-full">
									{loadingTitle}
								</div>
							) : null
						})()}
						<div className="text-description text-sm">Loading conversation…</div>
					</div>
				) : (
					<WelcomeSection
						shouldShowQuickWins={shouldShowQuickWins}
						showHistoryView={showHistoryView}
						taskHistory={taskHistory}
						telemetrySetting={telemetrySetting}
					/>
				)}
				{task && (
					<MessagesArea
						chatState={chatState}
						groupedMessages={groupedMessages}
						messageHandlers={messageHandlers}
						modifiedMessages={modifiedMessages}
						scrollBehavior={scrollBehavior}
						task={task}
					/>
				)}
			</div>
			{/* Cline Cubed: no input while the conversation is loading — a prompt typed into an
			    empty transcript takes the new-chat path and would FORK a new chat over the one
			    being restored (the silent-fork family). The load resolves in seconds. */}
			<footer
				className="bg-(--vscode-sidebar-background) flex flex-col"
				hidden={conversationLoading && !task}
				style={{ gridRow: "2" }}>
				<AutoApproveBar />
				<ActionButtons
					chatState={chatState}
					messageHandlers={messageHandlers}
					messages={messages}
					mode={mode}
					task={task}
				/>
				<QueuedPrompts items={queuedPrompts} />
				<InputSection
					chatState={chatState}
					messageHandlers={messageHandlers}
					placeholderText={placeholderText}
					scrollBehavior={scrollBehavior}
					selectFilesAndImages={selectFilesAndImages}
					shouldDisableFilesAndImages={shouldDisableFilesAndImages}
				/>
			</footer>
		</ChatLayout>
	)
}

export default ChatView
