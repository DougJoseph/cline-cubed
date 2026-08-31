import { StringRequest } from "@shared/proto/cline/common"
import { IntentEvent } from "@shared/proto/cline/ui"
import { HistoryIcon, PlusIcon, PuzzleIcon, SettingsIcon, UserCircleIcon } from "lucide-react"
import { useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TaskServiceClient, UiServiceClient } from "@/services/grpc-client"
import { useExtensionState } from "../../context/ExtensionStateContext"

export const Navbar = () => {
	const {
		navigateToHistory,
		navigateToSettings,
		navigateToAccount,
		navigateToMarketplace,
		navigateToChat,
		getSurfaceBoundTaskId,
	} = useExtensionState()

	const SETTINGS_TABS = useMemo(
		() => [
			{
				id: "chat",
				name: "Chat",
				tooltip: "New Task",
				icon: PlusIcon,
				navigate: () => {
					UiServiceClient.trackIntent(
						IntentEvent.create({
							action: "new_task_clicked",
							source: "navbar",
						}),
					).catch((error) => console.error("Failed to track new task click:", error))
					// Cline Cubed: close only THIS surface's own chat, then navigate. Bare
					// clearTask ends the ACTIVE session — with several chats open, a different
					// chat entirely. A surface with a routing id but no bound session is a Home:
					// nothing to close, so no RPC goes out. Bare clearTask survives only for
					// single-chat hosts with no surface routing.
					const boundTaskId = getSurfaceBoundTaskId()
					const closing =
						typeof boundTaskId === "string"
							? TaskServiceClient.closeTaskSession(StringRequest.create({ value: boundTaskId }))
							: window.__CLINE_CUBED_SURFACE_ID__ === undefined
								? TaskServiceClient.clearTask({})
								: Promise.resolve()
					closing
						.catch((error) => {
							console.error("Failed to close task:", error)
						})
						.finally(() => navigateToChat())
				},
			},
			{
				id: "customize",
				name: "Customize",
				tooltip: "Customize",
				icon: PuzzleIcon,
				navigate: navigateToMarketplace,
			},
			{
				id: "history",
				name: "History",
				tooltip: "History",
				icon: HistoryIcon,
				navigate: navigateToHistory,
			},
			{
				id: "account",
				name: "Account",
				tooltip: "Account",
				icon: UserCircleIcon,
				navigate: navigateToAccount,
			},
			{
				id: "settings",
				name: "Settings",
				tooltip: "Settings",
				icon: SettingsIcon,
				navigate: navigateToSettings,
			},
		],
		[navigateToAccount, navigateToChat, navigateToHistory, navigateToMarketplace, navigateToSettings, getSurfaceBoundTaskId],
	)

	return (
		<nav
			className="flex-none inline-flex justify-end bg-transparent gap-2 mb-1 z-10 border-none items-center mr-4!"
			id="cline-navbar-container">
			{SETTINGS_TABS.map((tab) => (
				<Tooltip key={`navbar-tooltip-${tab.id}`}>
					<TooltipContent side="bottom">{tab.tooltip}</TooltipContent>
					<TooltipTrigger asChild>
						<Button
							aria-label={tab.tooltip}
							className="p-0 h-7"
							data-testid={`tab-${tab.id}`}
							key={`navbar-button-${tab.id}`}
							onClick={() => tab.navigate()}
							size="icon"
							variant="icon">
							<tab.icon className="stroke-1 [svg]:size-4" size={18} />
						</Button>
					</TooltipTrigger>
				</Tooltip>
			))}
		</nav>
	)
}
