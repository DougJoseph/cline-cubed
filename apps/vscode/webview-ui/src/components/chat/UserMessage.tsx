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
	/**
	 * Real wall-clock creation time (Unix ms), stamped centrally when the message was
	 * appended extension-side. Absent on unstamped/legacy messages — no label is
	 * rendered then (never fall back to `messageTs`, which is the monotonic identity
	 * counter, not a clock).
	 */
	createdAt?: number
	sendMessageFromChatRow?: (text: string, images: string[], files: string[]) => void
	canRestoreWorkspace?: boolean
}

/**
 * Cline Cubed: a message's real wall-clock creation time, split into visible and detail
 * pieces — computed locally in the user's own timezone (zero tokens; the webview does it).
 * Returns null when unstamped — a label is never invented, and `ClineMessage.ts` (the
 * monotonic identity counter) must never be shown as a time.
 */
export function messageTimePieces(
	createdAt?: number,
): { datePrefix: string; hourMinute: string; secondsMs: string; tail: string } | null {
	if (!createdAt) {
		return null
	}
	const parts = new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
		fractionalSecondDigits: 3,
		hour12: true,
	}).formatToParts(new Date(createdAt))
	// Walk the locale's own parts into four buckets, so the split never drifts from what a
	// single toLocaleString would have printed: [Aug 30, 2026, ][5:23][:12.179][ PM].
	let datePrefix = ""
	let hourMinute = ""
	let secondsMs = ""
	let tail = ""
	let stage: "date" | "hourMinute" | "secondsMs" | "tail" = "date"
	for (const part of parts) {
		if (part.type === "hour") {
			stage = "hourMinute"
		} else if (part.type === "dayPeriod") {
			stage = "tail"
			// The space between the milliseconds and "PM" belongs to the visible tail, so the
			// collapsed detail piece never swallows the gap in "5:23 PM". Matched as
			// whitespace, not " ": modern ICU emits a NARROW NO-BREAK SPACE (U+202F) before
			// AM/PM, and an exact-space check missed it (caught in the pre-ship node check —
			// the label would have read "5:23PM").
			const trailing = secondsMs.match(/\s+$/)
			if (trailing) {
				secondsMs = secondsMs.slice(0, -trailing[0].length)
				tail = trailing[0]
			}
		}
		if (stage === "date") {
			datePrefix += part.value
		} else if (stage === "hourMinute") {
			hourMinute += part.value
			if (part.type === "minute") {
				stage = "secondsMs"
			}
		} else if (stage === "secondsMs") {
			secondsMs += part.value
		} else {
			tail += part.value
		}
	}
	return { datePrefix, hourMinute, secondsMs, tail }
}

/**
 * Cline Cubed: the shared time label above a message's content — user bubbles, AI replies,
 * and the completion rows. Design (all Doug's rulings, 2026-08-30):
 * - Short to the eye, full to the hand: the visible label is `5:23 PM`; the date and
 *   millisecond pieces are ALWAYS in the DOM but collapsed to `font-size: 0`, so every copy
 *   carries the full `Aug 30, 2026, 5:23:12.179 PM` (the clipboard serializes DOM text
 *   regardless of font size) and a pure-CSS hover (see the .msg-time-detail rules) restores
 *   them to full size in place.
 * - No color of its own: it inherits the SAME color as the message text beside it (the gray
 *   `descriptionForeground` was unreadable on dark themes); only the size is smaller.
 * - A real `<div>`, never a CSS-block span: the clipboard serializes by HTML semantics, and a
 *   span glued a copied label to the text on one line ("4:52:42.596 PMtest again…").
 */
export const MessageTimeLabel: React.FC<{ createdAt?: number; speaker: "User" | "AI"; inline?: boolean }> = ({
	createdAt,
	speaker,
	inline = false,
}) => {
	const pieces = useMemo(() => messageTimePieces(createdAt), [createdAt])
	if (!pieces) {
		return null
	}
	// `inline` sits INSIDE another element's flex row (the Completed block's header, left of
	// its Copy icon — Doug's cohesion ruling, 2026-08-30) instead of floating right over the
	// message; both variants share the hover-expansion and copy behavior.
	// No select-none on the label: it is ordinary selectable text, so the FIRST row's time can
	// be reached and copied too — user-select:none text is unreachable by drag and dropped at a
	// selection's edge, which is exactly where the topmost label always sits (Doug's copy test,
	// 2026-08-30).
	return (
		<div className={`${inline ? "msg-time-inline" : "msg-time-label"} text-[11px]`}>
			{/* Copy-only speaker prefix (Doug's idea, 2026-08-30): invisible always, so every
			    paste self-labels which side spoke. */}
			<span className="msg-copy-only">{speaker}: </span>
			<span className="msg-time-detail">{pieces.datePrefix}</span>
			{pieces.hourMinute}
			<span className="msg-time-detail">{pieces.secondsMs}</span>
			{pieces.tail}
		</div>
	)
}

/**
 * Cline Cubed: the clock time of one bridge-debug line, in the reader's own timezone. Seconds are
 * included because a run's lines land within the same minute and their order is the point.
 */
function formatBridgeTime(ts: number): string {
	return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

const UserMessage: React.FC<UserMessageProps> = ({ text, images, files, messageTs, createdAt, canRestoreWorkspace = true }) => {
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
	// Cline Cubed: image-bridge debug toggle + the retained interception runs from webview state.
	const { debugLoggingEnabled, imageBridgeDebug, currentTaskItem } = useExtensionState()
	/**
	 * Cline Cubed: this message's OWN bridge calls, or null when none can be shown for it.
	 *
	 * The state carries several recent runs. This message's run is the LATEST one that began at or
	 * before the message existed, among the runs belonging to this chat:
	 *
	 *  - WHICH CHAT. Each run carries its session id, matched against the chat this surface is
	 *    showing. Timing alone cannot answer this: a message in one chat is routinely created after
	 *    a bridge run in another, and would otherwise claim its lines.
	 *  - WHICH MESSAGE. A bridge run always completes before the message it produced exists, so a
	 *    run that began AFTER this message cannot be its own; of those that began before, the most
	 *    recent is the one this message came from, and older ones belong to earlier messages.
	 *
	 * A message with no creation stamp claims nothing, which is honest rather than a guess. So does
	 * a message whose run is no longer retained — see the empty state, which says only that no
	 * record is available, never that no calls were made.
	 */
	const ownBridgeLines = useMemo(() => {
		if (!imageBridgeDebug || imageBridgeDebug.length === 0 || createdAt === undefined) {
			return null
		}
		const thisChat = currentTaskItem?.id
		let own: (typeof imageBridgeDebug)[number] | null = null
		for (const run of imageBridgeDebug) {
			if (run.lines.length === 0 || run.startedAt > createdAt) {
				continue
			}
			if (run.sessionId && thisChat && run.sessionId !== thisChat) {
				continue
			}
			if (own === null || run.startedAt > own.startedAt) {
				own = run
			}
		}
		return own ? own.lines : null
	}, [imageBridgeDebug, createdAt, currentTaskItem])
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
					<MessageTimeLabel createdAt={createdAt} speaker="User" />
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
							{(debugLoggingEnabled === true || bridgeText.includes("[Image bridge failed")) && (
								<div
									onClick={(event) => event.stopPropagation()}
									style={{
										borderTop: "1px solid var(--vscode-editorGroup-border)",
										padding: "8px 10px",
										fontSize: "11px",
										color: "var(--vscode-descriptionForeground)",
									}}>
									<div style={{ fontWeight: 600, marginBottom: "2px", opacity: 0.9 }}>
										<i className="codicon codicon-debug" style={{ marginRight: 4 }} />
										Debug output — image bridge calls for this message
									</div>
									{/* Cline Cubed: say what this block IS. It appears mid-conversation, unasked,
									    and without this it reads as part of the chat rather than as diagnostics
									    someone switched on — and a reader who did not switch it on has no idea
									    where it came from or how to stop it. */}
									<div style={{ marginBottom: "6px", opacity: 0.7, fontSize: "10px" }}>
										{debugLoggingEnabled === true
											? "You are seeing this because Debug logging is ON (Settings → General → Debug logging)."
											: "Shown because this bridge call failed. Debug logging is OFF (Settings → General)."}
									</div>
									{/* Cline Cubed: only THIS message's bridge calls. A message created before a
									    run began cannot have caused it, so it shows the empty state rather than
									    borrowing another run's lines. A line that is a true statement about a
									    different message reads, under this one, as a claim about this one.

									    The empty state reports AVAILABILITY, never absence. Having no lines to
									    show has several causes — nothing bridged since this window loaded, a run
									    already pushed out by later ones, a message with no creation stamp — and
									    only one of them means no call was made. This panel cannot tell them
									    apart, so it must not claim the one it cannot establish: the calls may be
									    sitting in the log named just below. */}
									{/* Cline Cubed: the RESULT, and it is the only thing here at full text colour.
									    Everything around it — the heading, the line saying why the panel is on, the
									    log pointer and the switch — is chrome, and chrome set at the same weight as
									    the finding buries the finding. A left rule and its own space mark where the
									    answer is, so a glance lands on it rather than reading four lines to find
									    it. The empty state sits in the same block: "no record is available" is an
									    answer too, and just as easy to miss. */}
									<div
										style={{
											borderLeft: "2px solid var(--vscode-editorGroup-border)",
											paddingLeft: "8px",
											margin: "6px 0",
											color: "var(--vscode-foreground)",
											fontSize: "12px",
										}}>
										{ownBridgeLines === null ? (
											<div style={{ fontStyle: "italic" }}>
												No bridge-call record is available for this message. Records are kept in memory
												for recent messages only, so an older message's calls — and anything from before
												this window last loaded — are in the full log rather than here.
											</div>
										) : (
											ownBridgeLines.map((entry, index) => (
												<div
													key={index}
													style={{
														fontFamily: "var(--vscode-editor-font-family)",
														whiteSpace: "pre-wrap",
														wordBreak: "break-word",
														margin: "3px 0",
													}}>
													<span style={{ opacity: 0.6 }}>{formatBridgeTime(entry.ts)}</span>{" "}
													{entry.line}
												</div>
											))
										)}
									</div>
									<div style={{ marginTop: "4px", opacity: 0.8 }}>
										Full log: <code>View → Output → Cline Cubed</code>
										{" · "}
										{/* Cline Cubed: this switch used to cover the image bridge alone. It now
										    flips the extension-wide master setting, which is a bigger action than
										    it used to take — so the label says so instead of quietly doing more
										    than it says. */}
										<span
											className="cursor-pointer hover:brightness-110"
											onClick={(event) => {
												event.stopPropagation()
												void StateServiceClient.updateSettings(
													UpdateSettingsRequest.create({
														debugLoggingEnabled: debugLoggingEnabled !== true,
													}),
												)
											}}
											role="button"
											style={{ textDecoration: "underline" }}
											tabIndex={0}
											title="Toggle debug logging for the whole extension (General Settings → Debug logging)">
											Debug logging (whole extension):{" "}
											{debugLoggingEnabled === true ? "on — click to turn off" : "off — click to turn on"}
										</span>
									</div>
									{bridgeText.includes("[Image bridge failed") && (
										<div style={{ marginTop: "2px" }}>
											If you ever need this log again, turn on <b>Debug logging</b> in General Settings.
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
