import { MODEL_PROFILE_NAME_MAX_LENGTH } from "@shared/model-profiles"
import { PencilIcon } from "lucide-react"
import { useState } from "react"

interface ModelProfileListProps {
	names: string[]
	activeName: string
	onChoose: (name: string) => void
	onDelete: (name: string) => void
	/** Resolves to an error to show, or "" when the rename is done. */
	onRename: (oldName: string, newName: string) => Promise<string>
}

const rowButton = "cursor-pointer bg-transparent border-0 px-1.5 py-1 text-xs"

/**
 * Cline Cubed: the saved profiles as a list. Clicking a name switches to it. Each name carries a
 * pencil and an × as a pair: the pencil renames it in place, the × asks in place
 * before deleting it, since a VS Code webview cannot open a dialog.
 */
const ModelProfileList = ({ names, activeName, onChoose, onDelete, onRename }: ModelProfileListProps) => {
	const [confirming, setConfirming] = useState("")
	const [renaming, setRenaming] = useState("")
	const [renameText, setRenameText] = useState("")
	const [renameError, setRenameError] = useState("")

	if (names.length === 0) {
		return (
			<div className="px-2 py-1.5 text-xs text-(--vscode-descriptionForeground)" data-testid="model-profiles-empty">
				No profiles saved yet.
			</div>
		)
	}

	const startRename = (name: string) => {
		setConfirming("")
		setRenaming(name)
		setRenameText(name)
		setRenameError("")
	}

	const finishRename = async (name: string) => {
		const newName = renameText.trim()
		if (!newName) {
			setRenameError("Type the new name first.")
			return
		}
		if (newName === name) {
			setRenaming("")
			return
		}
		const error = await onRename(name, newName)
		if (error) {
			setRenameError(error)
		} else {
			setRenaming("")
		}
	}

	return (
		<ul className="m-0 p-0 list-none" data-testid="model-profiles-list">
			{names.map((name) => {
				if (renaming === name) {
					return (
						<li className="px-2 py-1" data-testid="model-profile-rename-row" key={name}>
							<div className="flex items-center gap-1">
								<input
									aria-label={`New name for ${name}`}
									autoFocus
									className="flex-1 min-w-0 rounded-sm border border-input-foreground/20 bg-input-background px-1.5 py-0.5 text-xs text-input-foreground focus-visible:outline-none"
									data-testid="model-profile-rename-name"
									maxLength={MODEL_PROFILE_NAME_MAX_LENGTH}
									onChange={(event) => setRenameText(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") void finishRename(name)
										if (event.key === "Escape") setRenaming("")
									}}
									value={renameText}
								/>
								<button
									className={`${rowButton} text-(--vscode-textLink-foreground)`}
									data-testid="model-profile-rename-ok"
									onClick={() => void finishRename(name)}
									type="button">
									Rename
								</button>
								<button
									className={`${rowButton} text-(--vscode-foreground)`}
									onClick={() => setRenaming("")}
									type="button">
									Cancel
								</button>
							</div>
							{renameError && (
								<div className="mt-1 text-xs text-(--vscode-errorForeground)" role="alert">
									{renameError}
								</div>
							)}
						</li>
					)
				}
				if (confirming === name) {
					return (
						<li
							className="flex items-center gap-1 px-2 py-1 text-xs"
							data-testid="model-profile-delete-confirm"
							key={name}>
							<span className="flex-1 min-w-0 truncate">Delete profile {name}?</span>
							<button
								className={`${rowButton} text-(--vscode-errorForeground)`}
								data-testid="model-profile-delete-yes"
								onClick={() => {
									setConfirming("")
									onDelete(name)
								}}
								type="button">
								Delete
							</button>
							<button
								className={`${rowButton} text-(--vscode-foreground)`}
								data-testid="model-profile-delete-no"
								onClick={() => setConfirming("")}
								type="button">
								Keep
							</button>
						</li>
					)
				}
				return (
					<li className="flex items-center hover:bg-(--vscode-list-hoverBackground)" key={name}>
						<button
							className="flex-1 min-w-0 truncate text-left cursor-pointer bg-transparent border-0 px-2 py-1 text-xs text-(--vscode-foreground)"
							data-testid="model-profile-choose"
							onClick={() => onChoose(name)}
							title={`Switch to ${name}`}
							type="button">
							{name === activeName ? "✓ " : ""}
							{name}
						</button>
						<button
							aria-label={`Rename profile ${name}`}
							className={`${rowButton} text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)`}
							data-testid="model-profile-rename"
							onClick={() => startRename(name)}
							title={`Rename profile ${name}`}
							type="button">
							<PencilIcon size={11} />
						</button>
						<button
							aria-label={`Delete profile ${name}`}
							className={`${rowButton} text-(--vscode-descriptionForeground) hover:text-(--vscode-errorForeground)`}
							data-testid="model-profile-delete"
							onClick={() => {
								setRenaming("")
								setConfirming(name)
							}}
							title={`Delete profile ${name}`}
							type="button">
							×
						</button>
					</li>
				)
			})}
		</ul>
	)
}

export default ModelProfileList
