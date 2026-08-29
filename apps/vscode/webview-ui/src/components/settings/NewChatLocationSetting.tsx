import React from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { updateSetting } from "./utils/settingsHandlers"

// The default first — it is where chats open until someone chooses otherwise.
const NEW_CHAT_LOCATION_OPTIONS = [
	{ value: "editor", label: "Editor area (new tab)" },
	{ value: "secondarySidebar", label: "Secondary sidebar (typically right)" },
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
					// The setting governs where FUTURE chats open; chats already open stay where
					// they are. Every new-chat button reads the persisted value live.
					updateSetting("newChatLocation", newLocation)
				}}
				value={newChatLocation || "editor"}>
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
				Where new chats open: the secondary sidebar, or as a tab in the editor area. Applies to every chat button; chats
				already open stay where they are. You can change this anytime via the gear in the message box or Settings →
				General.
			</p>
		</div>
	)
}

export default React.memo(NewChatLocationSetting)
