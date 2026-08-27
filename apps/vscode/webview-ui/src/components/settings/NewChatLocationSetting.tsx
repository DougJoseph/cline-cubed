import React from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PLATFORM_CONFIG } from "@/config/platform.config"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { updateSetting } from "./utils/settingsHandlers"

const NEW_CHAT_LOCATION_OPTIONS = [
	{ value: "primarySidebar", label: "Primary sidebar (typically left)" },
	{ value: "secondarySidebar", label: "Secondary sidebar (typically right)" },
	{ value: "editor", label: "Editor area (new tab)" },
] as const

const NewChatLocationSetting: React.FC = () => {
	const { newChatLocation } = useExtensionState()

	return (
		<div>
			<label className="block mb-1 text-base font-medium" htmlFor="new-chat-location-dropdown">
				Where new chat sessions open
			</label>
			<Select
				onValueChange={(newLocation) => {
					updateSetting("newChatLocation", newLocation)
					// Cline Cubed: swap the chat surface immediately — the containers' `when`
					// clauses key off the `cline-cubed:chatInPrimarySidebar` context, which the
					// host sets when it receives this message.
					PLATFORM_CONFIG.postMessage({ type: "syncChatLocation", newChatLocation: newLocation })
				}}
				value={newChatLocation || "secondarySidebar"}>
				<SelectTrigger className="w-full" id="new-chat-location-dropdown">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{NEW_CHAT_LOCATION_OPTIONS.map(({ value, label }) => (
						<SelectItem key={value} value={value}>
							{label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<p className="text-sm text-description mt-1">
				Where new chats open: the primary or secondary sidebar, or as a tab in the editor area. You can change this
				anytime via the gear in the message box or Settings → General.
			</p>
		</div>
	)
}

export default React.memo(NewChatLocationSetting)
