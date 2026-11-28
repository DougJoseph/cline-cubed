import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { LayersIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useClickAway, useWindowSize } from "react-use"
import PopupModalContainer from "@/components/common/PopupModalContainer"
import ModelProfileList from "@/components/settings/profiles/ModelProfileList"
import { useModelProfiles } from "@/components/settings/profiles/useModelProfiles"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"

/**
 * Cline Cubed: the composer's quick switcher for model profiles. Lists the saved profiles and
 * switches the current mode (both modes when Plan and Act share one model) without opening
 * Settings. Saving a profile is done under Settings, "My Profiles".
 */
const ModelProfileSwitcher = () => {
	const { mode, navigateToSettings } = useExtensionState()
	const profiles = useModelProfiles(mode === "plan" ? "plan" : "act")
	const [isVisible, setIsVisible] = useState(false)
	const buttonRef = useRef<HTMLDivElement>(null)
	const modalRef = useRef<HTMLDivElement>(null)
	const { width: viewportWidth, height: viewportHeight } = useWindowSize()
	const [arrowPosition, setArrowPosition] = useState(0)
	const [menuPosition, setMenuPosition] = useState(0)

	useClickAway(modalRef, () => setIsVisible(false))

	useEffect(() => {
		if (isVisible && buttonRef.current) {
			const buttonRect = buttonRef.current.getBoundingClientRect()
			const buttonCenter = buttonRect.left + buttonRect.width / 2
			setArrowPosition(document.documentElement.clientWidth - buttonCenter - 5)
			setMenuPosition(buttonRect.top + 1)
		}
	}, [isVisible, viewportWidth, viewportHeight])

	const label = profiles.activeName
		? `Profile: ${profiles.activeName}${profiles.activeEdited ? " (edited)" : ""}`
		: "My Profiles"

	return (
		<div className="inline-flex min-w-0 max-w-full items-center" ref={modalRef}>
			<div className="inline-flex w-full items-center" ref={buttonRef}>
				<Tooltip>
					{!isVisible && <TooltipContent>{label}</TooltipContent>}
					<TooltipTrigger>
						<VSCodeButton
							appearance="icon"
							aria-label={isVisible ? "Hide My Profiles" : "Show My Profiles"}
							className="p-0 m-0 flex items-center"
							data-testid="model-profile-switcher"
							onClick={() => setIsVisible(!isVisible)}>
							<LayersIcon size={12} />
						</VSCodeButton>
					</TooltipTrigger>
				</Tooltip>
			</div>

			{isVisible && (
				<PopupModalContainer $arrowPosition={arrowPosition} $menuPosition={menuPosition}>
					<div className="flex-shrink-0 px-3 pt-2">
						<div className="flex justify-between items-center mb-1">
							<div className="m-0 text-sm font-medium">My Profiles</div>
							<VSCodeButton
								appearance="icon"
								aria-label="Name and save this setup in Settings"
								onClick={() => {
									setIsVisible(false)
									navigateToSettings("api-config")
								}}
								title="Name and save this setup in Settings">
								<span className="codicon codicon-gear text-[10px]" />
							</VSCodeButton>
						</div>
						<p className="m-0 mb-2 text-xs text-(--vscode-descriptionForeground)">
							For speed switching between providers and models
							{profiles.activeEdited && profiles.activeName ? ` · ${profiles.activeName} (edited)` : ""}
						</p>
					</div>
					<div
						className="flex-1 overflow-y-auto px-1 pb-2"
						data-testid="model-profile-switcher-popover"
						style={{ minHeight: 0 }}>
						<ModelProfileList
							activeName={profiles.activeName}
							names={profiles.names}
							onChoose={(name) => {
								setIsVisible(false)
								void profiles.apply(name)
							}}
							onDelete={(name) => void profiles.remove(name)}
							onRename={profiles.renameInList}
						/>
						{profiles.error && (
							<div className="px-2 mt-1 text-xs text-(--vscode-errorForeground)" role="alert">
								{profiles.error}
							</div>
						)}
					</div>
				</PopupModalContainer>
			)}
		</div>
	)
}

export default ModelProfileSwitcher
