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
			{/* States the two facts the dropdown itself cannot: that the SECONDARY sidebar holds ONE
				chat and further chats become editor tabs (so choosing it is not a promise that chats
				stack there), and that the choice governs future chats only. It names that sidebar
				explicitly — there are two, doing different jobs, the primary holding the chats list
				and the secondary a docked chat, so a bare "sidebar" reads as a claim about both
				(Doug, 2026-08-31). Deliberately does NOT restate the label above it, and does not
				explain where to find a setting the reader is currently looking at. */}
			<p className="text-sm text-description mt-1">
				The secondary sidebar holds one chat, at full height; further chats open as editor tabs. Chats already open stay
				where they are.
			</p>
		</div>
	)
}

export default React.memo(NewChatLocationSetting)
