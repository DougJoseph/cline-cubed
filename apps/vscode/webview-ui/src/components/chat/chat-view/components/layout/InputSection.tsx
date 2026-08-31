import { splitImageBridgeBlock } from "@shared/bridge/constants"
import React, { useMemo } from "react"
import ChatTextArea from "@/components/chat/ChatTextArea"
import QuotedMessagePreview from "@/components/chat/QuotedMessagePreview"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ChatState, MessageHandlers, ScrollBehavior } from "../../types/chatTypes"

interface InputSectionProps {
	chatState: ChatState
	messageHandlers: MessageHandlers
	scrollBehavior: ScrollBehavior
	placeholderText: string
	shouldDisableFilesAndImages: boolean
	selectFilesAndImages: () => Promise<void>
}

/**
 * Input section including quoted message preview and chat text area
 */
export const InputSection: React.FC<InputSectionProps> = ({
	chatState,
	messageHandlers,
	scrollBehavior,
	placeholderText,
	shouldDisableFilesAndImages,
	selectFilesAndImages,
}) => {
	const {
		activeQuote,
		setActiveQuote,
		isTextAreaFocused,
		inputValue,
		setInputValue,
		sendingDisabled,
		selectedImages,
		setSelectedImages,
		selectedFiles,
		setSelectedFiles,
		textAreaRef,
		handleFocusChange,
		lastMessage,
	} = chatState

	const { isAtBottom, scrollToBottomAuto } = scrollBehavior
	const { turnState, clineMessages } = useExtensionState()

	// Cline Cubed: THIS chat's previous prompts for up-arrow history cycling, newest first —
	// derived from the surface's own transcript, so it is per chat by construction and works
	// on chats reopened from history (their rows are rebuilt). Consecutive duplicates
	// collapse, and the bridged-image block is stripped the same way the display strips it.
	const promptHistory = useMemo(() => {
		const prompts: string[] = []
		for (const message of clineMessages) {
			if (message.type === "say" && (message.say === "task" || message.say === "user_feedback") && message.text) {
				const { userText } = splitImageBridgeBlock(message.text)
				const prompt = userText.trim()
				if (prompt && prompts[prompts.length - 1] !== prompt) {
					prompts.push(prompt)
				}
			}
		}
		return prompts.reverse()
	}, [clineMessages])
	const legacyTaskRunning =
		turnState === undefined &&
		(lastMessage?.partial === true || (lastMessage?.type === "say" && lastMessage.say === "api_req_started"))
	const allowQueuedSubmit = turnState?.phase === "streaming" || turnState?.phase === "awaiting_approval" || legacyTaskRunning
	const submitDisabled = sendingDisabled && !allowQueuedSubmit

	return (
		<>
			{activeQuote && (
				<div style={{ marginBottom: "-12px", marginTop: "10px" }}>
					<QuotedMessagePreview
						isFocused={isTextAreaFocused}
						onDismiss={() => setActiveQuote(null)}
						text={activeQuote}
					/>
				</div>
			)}

			<ChatTextArea
				activeQuote={activeQuote}
				inputValue={inputValue}
				onFocusChange={handleFocusChange}
				onHeightChange={() => {
					if (isAtBottom) {
						scrollToBottomAuto()
					}
				}}
				onSelectFilesAndImages={selectFilesAndImages}
				onSend={() => messageHandlers.handleSendMessage(inputValue, selectedImages, selectedFiles)}
				placeholderText={placeholderText}
				promptHistory={promptHistory}
				ref={textAreaRef}
				selectedFiles={selectedFiles}
				selectedImages={selectedImages}
				sendingDisabled={submitDisabled}
				setInputValue={setInputValue}
				setSelectedFiles={setSelectedFiles}
				setSelectedImages={setSelectedImages}
				shouldDisableFilesAndImages={shouldDisableFilesAndImages}
			/>
		</>
	)
}
