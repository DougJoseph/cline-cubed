import { chatDisplayTitle } from "@shared/HistoryItem"
import { TaskTitleRequest } from "@shared/proto/cline/task"
import { PencilIcon } from "lucide-react"
import { memo, useCallback, useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"

type EditableChatTitleProps = {
	/** The chat being named. Without one the title renders as plain text — nothing to write to. */
	taskId?: string
	/** The chat's own name, when it has one. */
	title?: string
	/** The chat's first prompt — what it is displayed by until it is named. */
	fallback: string
	/** Classes for the displayed text (line clamping, size, weight). */
	className?: string
	/** Called after a rename lands, for surfaces that fetch their own list and must refresh. */
	onRenamed?: () => void
	/**
	 * Where this name lives — which decides both what reveals the pencil AND what a click on the
	 * name itself does.
	 *
	 * `"self"` (default) — the name stands alone, at the top of a chat, with nothing behind it to
	 * click through to. Hovering the name reveals the pencil, and clicking the name renames.
	 *
	 * `"row"` — the name sits inside a row whose own job is to OPEN the chat. The row's hover
	 * reveals the pencil along with its other icons, so one hover advertises everything the row can
	 * do; and the name is plain text, so a click passes through to the row and opens the chat. The
	 * pencil alone renames. Requires an ancestor with Tailwind's bare `group` class.
	 *
	 * Doug, 2026-08-28: on a history row the self-scoped hover meant the pencil only appeared once
	 * you had already found the title, while the delete and details icons appeared from anywhere on
	 * the row. Doug, 2026-09-02: the name is where a person clicks to OPEN a chat, so a click there
	 * that starts a rename instead is a surprise the row itself invites.
	 */
	revealOn?: "self" | "row"
}

/**
 * Cline Cubed: a chat's name, edited in place.
 *
 * A pencil appears on hover and starts the rename. Where the name has nothing behind it to click
 * through to (`revealOn="self"`), clicking the name starts it too; inside a row that opens the chat
 * (`revealOn="row"`), the name is plain text and only the pencil renames. Enter or blur commits,
 * Escape cancels. Clearing the box removes the name and restores the chat's first prompt, so a
 * rename is always undoable.
 *
 * It writes to `setTaskTitle`, which stores the name in its own field — renaming never rewrites
 * what the person actually typed as their first prompt.
 *
 * Every click and key is stopped from propagating, because this sits inside surfaces that treat a
 * click as "open this chat" (a history row) or a keypress as a chat shortcut.
 */
const EditableChatTitle = ({ taskId, title, fallback, className, onRenamed, revealOn = "self" }: EditableChatTitleProps) => {
	const displayed = chatDisplayTitle({ title, task: fallback })
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState(displayed)
	const inputRef = useRef<HTMLInputElement>(null)
	// Blur commits, but Escape blurs too — this suppresses the commit for that one blur.
	const cancelledRef = useRef(false)

	useEffect(() => {
		if (editing) {
			setDraft(displayed)
			cancelledRef.current = false
		}
	}, [editing, displayed])

	useEffect(() => {
		if (editing && inputRef.current) {
			inputRef.current.focus()
			inputRef.current.select()
		}
	}, [editing])

	const commit = useCallback(() => {
		setEditing(false)
		if (!taskId) {
			return
		}
		const next = draft.trim()
		const current = (title ?? "").trim()
		// An empty box, or a name identical to the first prompt, means "no name of its own" — send
		// the empty string so the stored name is cleared rather than duplicating the prompt.
		const toSend = next && next !== fallback.trim() ? next : ""
		if (toSend === current) {
			return
		}
		TaskServiceClient.setTaskTitle(TaskTitleRequest.create({ taskId, title: toSend }))
			.then(() => onRenamed?.())
			.catch((error) => console.error("Error renaming chat:", error))
	}, [draft, fallback, onRenamed, taskId, title])

	if (!taskId) {
		return <span className={className}>{displayed}</span>
	}

	if (editing) {
		return (
			<input
				className={cn(
					"w-full bg-input-background text-foreground border border-focus-border rounded-xs px-1 py-0.5 outline-none",
					className,
				)}
				onBlur={() => {
					if (cancelledRef.current) {
						cancelledRef.current = false
						setEditing(false)
						return
					}
					commit()
				}}
				onChange={(e) => setDraft(e.target.value)}
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => {
					e.stopPropagation()
					if (e.key === "Enter") {
						e.preventDefault()
						commit()
					} else if (e.key === "Escape") {
						e.preventDefault()
						cancelledRef.current = true
						setEditing(false)
					}
				}}
				ref={inputRef}
				value={draft}
			/>
		)
	}

	const revealWithRow = revealOn === "row"

	const startEditing = (e: React.SyntheticEvent) => {
		e.stopPropagation()
		e.preventDefault()
		setEditing(true)
	}

	// Inside a row that opens the chat, the pencil is the whole rename affordance: the name is
	// plain text so its click reaches the row. Standing alone, the name is the affordance and the
	// pencil is a hint, so it takes no clicks of its own.
	const pencil = (
		<PencilIcon
			className={cn(
				"size-2 shrink-0 stroke-1 text-description opacity-0 transition-opacity",
				revealWithRow
					? "group-hover:opacity-100 focus-visible:opacity-100"
					: "group-hover/title:opacity-100 group-focus-within/title:opacity-100",
			)}
		/>
	)

	if (revealWithRow) {
		return (
			<span className="inline-flex items-center gap-1 min-w-0">
				<span className={cn("min-w-0", className)}>{displayed}</span>
				<span
					aria-label={`Rename chat: ${displayed}`}
					className="shrink-0 inline-flex items-center rounded-xs p-1 -m-1 cursor-pointer transition-colors hover:bg-accent/20"
					onClick={startEditing}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							startEditing(e)
						}
					}}
					role="button"
					tabIndex={0}
					title="Rename this chat">
					{pencil}
				</span>
			</span>
		)
	}

	return (
		<span
			aria-label={`Rename chat: ${displayed}`}
			className="group/title inline-flex items-center gap-1 min-w-0 rounded-xs px-1 -mx-1 cursor-text transition-colors hover:bg-accent/10"
			onClick={startEditing}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					startEditing(e)
				}
			}}
			role="button"
			tabIndex={0}
			title="Click to rename this chat">
			<span className={cn("min-w-0", className)}>{displayed}</span>
			{pencil}
		</span>
	)
}

export default memo(EditableChatTitle)
