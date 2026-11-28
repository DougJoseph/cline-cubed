import { MODEL_PROFILE_NAME_MAX_LENGTH } from "@shared/model-profiles"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useRef, useState } from "react"
import { useClickAway } from "react-use"
import { Button } from "@/components/ui/button"
import ModelProfileList from "./ModelProfileList"
import { type ProfileMode, useModelProfiles } from "./useModelProfiles"

/**
 * Cline Cubed: "My Profiles", at the top of the API Configuration section. The name box is a
 * dropdown: pick a saved profile to switch to it, or type a new name and save the current setup
 * under it. Each saved name carries a pencil (rename) and an × (delete).
 */
const ModelProfilesBar = ({ mode }: { mode: ProfileMode }) => {
	const profiles = useModelProfiles(mode)
	const [text, setText] = useState(profiles.activeName)
	const [open, setOpen] = useState(false)
	const [pendingReplace, setPendingReplace] = useState("")
	const [message, setMessage] = useState("")
	// What the last save or switch did, said in plain words so a press never looks like nothing happened.
	const [note, setNote] = useState("")
	const boxRef = useRef<HTMLDivElement>(null)
	useClickAway(boxRef, () => setOpen(false))

	// The box follows the active profile when it changes (a switch from the composer, a reload).
	useEffect(() => {
		setText(profiles.activeName)
	}, [profiles.activeName])

	const error = message || profiles.error

	const save = async (replace: boolean) => {
		const name = text.trim()
		setMessage("")
		setNote("")
		if (!name) {
			setMessage("Type a name for this setup first.")
			return
		}
		const response = await profiles.save(name, replace)
		if (response.nameExists) {
			setPendingReplace(name)
		} else {
			setPendingReplace("")
			if (!response.error) setNote(replace ? `Replaced ${name} with this setup.` : `Saved this setup as ${name}.`)
		}
	}

	const choose = async (name: string) => {
		setOpen(false)
		setMessage("")
		setPendingReplace("")
		setNote("")
		setText(name)
		const response = await profiles.apply(name)
		if (!response.error) setNote(`Switched to ${name}.`)
	}

	return (
		<div className="mb-4" data-testid="model-profiles-bar">
			<div className="text-sm font-medium">My Profiles</div>
			<p className="text-xs mt-0.5 mb-2 text-(--vscode-descriptionForeground)">
				For speed switching between providers and models
			</p>

			<div className="flex flex-wrap items-center gap-2">
				<div className="relative flex-1 min-w-[10rem]" ref={boxRef}>
					<div className="flex items-center rounded-sm border border-input-foreground/20 bg-input-background">
						<input
							aria-label="Profile name"
							className="flex-1 min-w-0 bg-transparent border-0 px-2 py-1 text-sm text-input-foreground focus-visible:outline-none"
							data-testid="model-profile-name"
							maxLength={MODEL_PROFILE_NAME_MAX_LENGTH}
							onChange={(event) => {
								setText(event.target.value)
								setPendingReplace("")
							}}
							onFocus={() => setOpen(true)}
							onKeyDown={(event) => {
								if (event.key === "Enter") void save(false)
								if (event.key === "Escape") setOpen(false)
							}}
							placeholder={
								profiles.names.length > 0 ? "Choose a profile, or type a new name" : "Type a name for this setup"
							}
							value={text}
						/>
						<button
							aria-label={open ? "Hide saved profiles" : "Show saved profiles"}
							className="cursor-pointer bg-transparent border-0 px-2 py-1 text-xs text-(--vscode-foreground)"
							data-testid="model-profile-toggle"
							onClick={() => setOpen(!open)}
							type="button">
							▾
						</button>
					</div>
					{open && (
						<div className="absolute left-0 right-0 z-20 mt-1 rounded-sm border border-(--vscode-dropdown-border) bg-(--vscode-dropdown-background) py-1 shadow-md">
							<ModelProfileList
								activeName={profiles.activeName}
								names={profiles.names}
								onChoose={(name) => void choose(name)}
								onDelete={(name) => void profiles.remove(name)}
								onRename={profiles.renameInList}
							/>
						</div>
					)}
				</div>
				{profiles.activeName && profiles.activeEdited && text === profiles.activeName && (
					<span className="text-xs text-(--vscode-descriptionForeground)" data-testid="model-profile-edited">
						(edited)
					</span>
				)}
				<Button data-testid="model-profile-save" onClick={() => void save(false)} size="sm" type="button">
					Name and save this setup
				</Button>
			</div>

			{pendingReplace && (
				<div className="flex items-center gap-2 mt-2 text-xs" data-testid="model-profile-replace-confirm">
					<span className="flex-1 min-w-0">
						A profile named {pendingReplace} is already saved. Replace it with this setup?
					</span>
					<VSCodeButton className="shrink-0" data-testid="model-profile-replace-yes" onClick={() => void save(true)}>
						Replace
					</VSCodeButton>
					<VSCodeButton
						appearance="secondary"
						className="shrink-0"
						data-testid="model-profile-replace-no"
						onClick={() => setPendingReplace("")}>
						Keep
					</VSCodeButton>
				</div>
			)}

			{note && !error && (
				<div
					className="mt-2 text-xs text-(--vscode-descriptionForeground)"
					data-testid="model-profile-note"
					role="status">
					{note}
				</div>
			)}

			{error && (
				<div className="mt-2 text-xs text-(--vscode-errorForeground)" data-testid="model-profile-error" role="alert">
					{error}
				</div>
			)}
		</div>
	)
}

export default ModelProfilesBar
