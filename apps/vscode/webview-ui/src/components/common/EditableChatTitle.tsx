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
	 * Where the hover that reveals the pencil comes from.
	 *
	 * `"self"` (default) — hovering the NAME reveals it. Right at the top of a chat, where the name
	 * is the only thing on its line and the surrounding row means "expand the header".
	 *
	 * `"row"` — the enclosing row's hover reveals it, along with that row's other icons, so one
	 * hover advertises everything the row can do at once. Requires an ancestor with Tailwind's
	 * bare `group` class. Doug, 2026-08-28: on a history row the self-scoped version meant the
	 * pencil only appeared once you had already found the title, while the delete and details
	 * icons appeared from anywhere on the row.
	 */
	revealOn?: "self" | "row"
}

/**
 * Cline Cubed: a chat's name, edited in place.
 *
 * Hovering tints the name and shows a pencil; clicking either the name or the pencil drops into an
 * input. Enter or blur commits, Escape cancels. Clearing the box removes the name and restores the
 * chat's first prompt, so a rename is always undoable.
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

	return (
		<span
			aria-label={`Rename chat: ${displayed}`}
			className={cn(
				"group/title inline-flex items-center gap-1 min-w-0 rounded-xs px-1 -mx-1 cursor-text transition-colors",
				revealWithRow ? "group-hover:bg-accent/10" : "hover:bg-accent/10",
			)}
			onClick={(e) => {
				e.stopPropagation()
				setEditing(true)
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.stopPropagation()
					e.preventDefault()
					setEditing(true)
				}
			}}
			role="button"
			tabIndex={0}
			title="Click to rename this chat">
			<span className={cn("min-w-0", className)}>{displayed}</span>
			<PencilIcon
				className={cn(
					"size-2 shrink-0 stroke-1 text-description opacity-0 transition-opacity group-focus-within/title:opacity-100",
					revealWithRow ? "group-hover:opacity-100" : "group-hover/title:opacity-100",
				)}
			/>
		</span>
	)
}

export default memo(EditableChatTitle)
