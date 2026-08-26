import { splitImageBridgeBlock } from "@shared/bridge/constants"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { EditMessageAndRegenerateRequest } from "@shared/proto/cline/task"
import type React from "react"
import { useMemo, useState } from "react"
import { CHAT_ROW_EXPANDED_BG_COLOR } from "@/components/common/CodeBlock"
import Thumbnails from "@/components/common/Thumbnails"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient, TaskServiceClient } from "@/services/grpc-client"
import { highlightText } from "./task-header/Highlights"

interface UserMessageProps {
	text?: string
	files?: string[]
	images?: string[]
	messageTs?: number
	sendMessageFromChatRow?: (text: string, images: string[], files: string[]) => void
	canRestoreWorkspace?: boolean
}

const UserMessage: React.FC<UserMessageProps> = ({ text, images, files, messageTs, canRestoreWorkspace = true }) => {
	const [isEditing, setIsEditing] = useState(false)
	const [editedText, setEditedText] = useState(text ?? "")
	const [editedImages, setEditedImages] = useState(images ?? [])
	const [editedFiles, setEditedFiles] = useState(files ?? [])
	const [savingMode, setSavingMode] = useState<"chat" | "workspace" | undefined>()
	const [errorMessage, setErrorMessage] = useState<string | undefined>()
	// Cline Cubed: the bridged image description is appended to the user
	// message text; display it as a rolled-up (collapsible) block.
	const [bridgeExpanded, setBridgeExpanded] = useState(false)
	// Cline Cubed: bridged-description copy feedback (resets after 1.5s).
	const [bridgeCopied, setBridgeCopied] = useState(false)
	// Cline Cubed: image-bridge debug toggle + recent call lines from webview state.
	const { imageBridgeDebugEnabled, imageBridgeDebug } = useExtensionState()
	const { userText, bridgeText } = useMemo(() => splitImageBridgeBlock(text ?? ""), [text])
	const highlightedText = useMemo(() => highlightText(userText), [userText])

	const startEditing = () => {
		setEditedText(text ?? "")
		setEditedImages(images ?? [])
		setEditedFiles(files ?? [])
		setErrorMessage(undefined)
		setIsEditing(true)
	}

	const cancelEditing = () => {
		if (savingMode) {
			return
		}
		setIsEditing(false)
	}

	const handleEditingKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Escape") {
			return
		}

		event.preventDefault()
		event.stopPropagation()
		cancelEditing()
	}

	const handleSave = async (restoreWorkspace: boolean) => {
		if (!messageTs || savingMode) {
			return
		}
		setSavingMode(restoreWorkspace ? "workspace" : "chat")
		setErrorMessage(undefined)
		try {
			await TaskServiceClient.editMessageAndRegenerate(
				EditMessageAndRegenerateRequest.create({
					messageTs,
					text: editedText,
					images: editedImages,
					files: editedFiles,
					restoreWorkspace,
				}),
			)
			setIsEditing(false)
			setSavingMode(undefined)
		} catch (error) {
			console.error("Failed to edit and regenerate message:", error)
			setErrorMessage(error instanceof Error ? error.message : "Failed to edit and regenerate message")
			setSavingMode(undefined)
		}
	}

	return (
		<div
			className={`group relative p-2.5 my-1 text-badge-foreground rounded-xs ${
				messageTs && !isEditing ? "cursor-pointer pr-8" : ""
			}`}
			onClick={messageTs && !isEditing ? startEditing : undefined}
			onKeyDown={
				messageTs && !isEditing
					? (event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault()
								startEditing()
							}
						}
					: undefined
			}
			role={messageTs && !isEditing ? "button" : undefined}
			style={{
				backgroundColor: "var(--vscode-badge-background)",
				whiteSpace: "pre-line",
				wordWrap: "break-word",
			}}
			tabIndex={messageTs && !isEditing ? 0 : undefined}
			title={messageTs && !isEditing ? "Edit and regenerate from here" : undefined}>
			{messageTs && !isEditing && (
				<Tooltip>
					<TooltipContent side="left">Edit and regenerate from here</TooltipContent>
					<TooltipTrigger asChild>
						<button
							aria-label="Edit and regenerate from this message"
							className="absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-80 hover:opacity-100 bg-transparent border-0 text-badge-foreground cursor-pointer p-1"
							onClick={(event) => {
								event.stopPropagation()
								startEditing()
							}}
							type="button">
							<i className="codicon codicon-edit" />
						</button>
					</TooltipTrigger>
				</Tooltip>
			)}
			{isEditing ? (
				<div className="flex flex-col gap-2" onKeyDown={handleEditingKeyDown}>
					<textarea
						className="w-full box-border rounded-xs border border-vscode-input-border bg-vscode-input-background text-vscode-input-foreground p-2 text-sm resize-vertical"
						disabled={!!savingMode}
						onChange={(event) => setEditedText(event.target.value)}
						rows={Math.max(3, editedText.split("\n").length)}
						value={editedText}
					/>
					{(editedImages.length > 0 || editedFiles.length > 0) && (
						<Thumbnails
							files={editedFiles}
							images={editedImages}
							setFiles={setEditedFiles}
							setImages={setEditedImages}
						/>
					)}
					{errorMessage && <div className="text-xs text-(--vscode-errorForeground)">{errorMessage}</div>}
					<div className="flex items-center justify-between gap-1.5">
						<button
							className="shrink-0 whitespace-nowrap px-1 py-1 rounded-xs border-0 bg-transparent text-badge-foreground/80 hover:text-badge-foreground cursor-pointer text-xs"
							disabled={!!savingMode}
							onClick={cancelEditing}
							type="button">
							Cancel
						</button>
						<div className="flex items-center gap-1.5">
							<Tooltip>
								<TooltipContent side="top">Rewind conversation, keep current code edits</TooltipContent>
								<TooltipTrigger asChild>
									<span className="inline-flex shrink-0">
										<button
											className="whitespace-nowrap px-2 py-1 rounded-xs border border-vscode-button-border bg-transparent text-badge-foreground cursor-pointer disabled:opacity-60 text-xs"
											disabled={!!savingMode}
											onClick={() => handleSave(false)}
											type="button">
											{savingMode === "chat" ? "Running..." : "Reset Chat"}
										</button>
									</span>
								</TooltipTrigger>
							</Tooltip>
							{canRestoreWorkspace && (
								<Tooltip>
									<TooltipContent side="top">Rewind conversation, reset code edits</TooltipContent>
									<TooltipTrigger asChild>
										<span className="inline-flex shrink-0">
											<button
												className="whitespace-nowrap px-2 py-1 rounded-xs border border-vscode-button-border bg-transparent text-badge-foreground cursor-pointer disabled:opacity-60 text-xs"
												disabled={!!savingMode}
												onClick={() => handleSave(true)}
												type="button">
												{savingMode === "workspace" ? "Restoring..." : "Reset Code"}
											</button>
										</span>
									</TooltipTrigger>
								</Tooltip>
							)}
						</div>
					</div>
				</div>
			) : (
				<>
					<span className="ph-no-capture text-sm" style={{ display: "block" }}>
						{highlightedText}
					</span>
					{bridgeText && (
						<div
							onClick={(event) => event.stopPropagation()}
							style={{
								marginTop: "8px",
								borderRadius: "6px",
								border: "1px solid var(--vscode-editorGroup-border)",
								backgroundColor: CHAT_ROW_EXPANDED_BG_COLOR,
								overflow: "hidden",
							}}>
							<button
								aria-expanded={bridgeExpanded}
								className="w-full flex items-center gap-1.5 px-2.5 py-1.5 bg-transparent border-0 cursor-pointer text-left text-xs hover:brightness-110"
								onClick={(event) => {
									event.stopPropagation()
									setBridgeExpanded((expanded) => !expanded)
								}}
								style={{ color: "var(--vscode-descriptionForeground)" }}
								type="button">
								<i className={`codicon ${bridgeExpanded ? "codicon-chevron-down" : "codicon-chevron-right"}`} />
								<span style={{ fontWeight: 500 }}>Image description (from Image Mode bridge)</span>
								<span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" }}>
									<span style={{ fontSize: "11px" }}>{bridgeText.length.toLocaleString()} chars</span>
									<span
										className="inline-flex items-center gap-1 cursor-pointer hover:brightness-110"
										onClick={(event) => {
											// Copy the description without triggering the row's
											// edit-mode handler or the collapse toggle.
											event.stopPropagation()
											void navigator.clipboard
												.writeText(bridgeText)
												.then(() => {
													setBridgeCopied(true)
													setTimeout(() => setBridgeCopied(false), 1500)
												})
												.catch(() => {})
										}}
										role="button"
										tabIndex={0}
										title="Copy description">
										<i className={`codicon ${bridgeCopied ? "codicon-check" : "codicon-copy"}`} />
										{bridgeCopied && <span>Copied</span>}
									</span>
								</span>
							</button>
							{bridgeExpanded && (
								<div
									className="text-xs"
									onClick={(event) => event.stopPropagation()}
									style={{
										padding: "8px 10px",
										whiteSpace: "pre-wrap",
										wordBreak: "break-word",
										maxHeight: "40vh",
										overflowY: "auto",
										userSelect: "text",
										borderTop: "1px solid var(--vscode-editorGroup-border)",
										color: "var(--vscode-foreground)",
									}}>
									{bridgeText}
								</div>
							)}
							{(imageBridgeDebugEnabled === true || bridgeText.includes("[Image bridge failed")) && (
								<div
									onClick={(event) => event.stopPropagation()}
									style={{
										borderTop: "1px solid var(--vscode-editorGroup-border)",
										padding: "8px 10px",
										fontSize: "11px",
										color: "var(--vscode-descriptionForeground)",
									}}>
									<div style={{ fontWeight: 600, marginBottom: "4px" }}>
										<i className="codicon codicon-debug" style={{ marginRight: 4 }} />
										Image bridge debug
									</div>
									{(imageBridgeDebug?.lines ?? []).slice(-3).map((line, index) => (
										<div
											key={index}
											style={{
												fontFamily: "var(--vscode-editor-font-family)",
												whiteSpace: "pre-wrap",
												wordBreak: "break-word",
												margin: "2px 0",
											}}>
											{line}
										</div>
									))}
									<div style={{ marginTop: "4px" }}>
										Full log: <code>View → Output → Cline Cubed</code>
										{" · "}
										<span
											className="cursor-pointer hover:brightness-110"
											onClick={(event) => {
												event.stopPropagation()
												void StateServiceClient.updateSettings(
													UpdateSettingsRequest.create({
														imageBridgeDebugEnabled: imageBridgeDebugEnabled !== true,
													}),
												)
											}}
											role="button"
											style={{ textDecoration: "underline" }}
											tabIndex={0}
											title="Toggle image-bridge debug logging in Settings">
											Debug logging:{" "}
											{imageBridgeDebugEnabled === true
												? "on — click to turn off"
												: "off — click to turn on"}
										</span>
									</div>
									{bridgeText.includes("[Image bridge failed") && (
										<div style={{ marginTop: "2px" }}>
											If you ever need this log again, enable it in Settings → API Configuration → Image
											tab.
										</div>
									)}
								</div>
							)}
						</div>
					)}
				</>
			)}
			{!isEditing && ((images && images.length > 0) || (files && files.length > 0)) && (
				<Thumbnails files={files ?? []} images={images ?? []} style={{ marginTop: "8px" }} />
			)}
		</div>
	)
}

export default UserMessage
