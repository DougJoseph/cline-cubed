import { chatDisplayTitle } from "@shared/HistoryItem"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useMemo, useState } from "react"
import AccountView from "@/components/account/AccountView"
import HistoryView from "@/components/history/HistoryView"
import MarketplaceView from "@/components/marketplace/MarketplaceView"
import SettingsView from "@/components/settings/SettingsView"
import { PLATFORM_CONFIG } from "@/config/platform.config"
import { useClineAuth } from "@/context/ClineAuthContext"
import { useExtensionState } from "@/context/ExtensionStateContext"

type OpenChat = { sessionId: string; location: string }

/**
 * The chats list in the primary activity-bar container.
 *
 * Not a chat surface: it never renders a conversation. It shows the chats open right now and
 * where each one lives, then the full history, with New Chat at the top. Clicking any row asks
 * the HOST to open that chat — revealed where it already lives, or opened in the configured
 * location if it is not open anywhere. That is deliberately different from clicking history
 * inside a chat, which binds THAT webview to the task; this list has no conversation of its own
 * to bind.
 */
const SessionsListView = () => {
	const { taskHistory } = useExtensionState()
	const { clineUser, organizations, activeOrganization } = useClineAuth()
	const [openChats, setOpenChats] = useState<OpenChat[]>([])
	// Cline Cubed: this panel's own toolbar buttons open their view HERE, over the list, with
	// Done returning to it — rather than driving whatever chat happens to be active elsewhere.
	const [listPanel, setListPanel] = useState<"marketplace" | "account" | "settings" | undefined>(undefined)

	// The host pushes the open-chat picture on every surface change and whenever this view
	// becomes visible, so the list never has to poll.
	useEffect(() => {
		const onHostMessage = (event: MessageEvent) => {
			const data = event.data as {
				type?: string
				openChats?: OpenChat[]
				listPanel?: "marketplace" | "account" | "settings"
			}
			if (data?.type === "openChats") {
				setOpenChats(data.openChats ?? [])
			} else if (data?.type === "showListPanel" && data.listPanel) {
				setListPanel(data.listPanel)
			}
		}
		window.addEventListener("message", onHostMessage)
		return () => window.removeEventListener("message", onHostMessage)
	}, [])

	// Titles come from taskHistory rather than from the host, so the host only sends ids.
	const openRows = useMemo(
		() =>
			openChats.map((chat) => ({
				...chat,
				title: (() => {
					const item = taskHistory?.find((entry) => entry.id === chat.sessionId)
					return item ? chatDisplayTitle(item) : "New chat"
				})(),
			})),
		[openChats, taskHistory],
	)

	const openSession = (sessionId: string) => {
		PLATFORM_CONFIG.postMessage({ type: "openSession", sessionId })
	}

	if (listPanel === "settings") {
		return <SettingsView onDone={() => setListPanel(undefined)} />
	}
	if (listPanel === "marketplace") {
		return <MarketplaceView onDone={() => setListPanel(undefined)} />
	}
	if (listPanel === "account") {
		return (
			<AccountView
				activeOrganization={activeOrganization}
				clineUser={clineUser}
				onDone={() => setListPanel(undefined)}
				organizations={organizations}
			/>
		)
	}

	return (
		<div className="flex h-screen w-full flex-col">
			<div className="flex items-center justify-between px-4 pt-3 pb-2">
				<h3 className="m-0 text-base font-semibold">Chats</h3>
				<VSCodeButton appearance="primary" onClick={() => PLATFORM_CONFIG.postMessage({ type: "newChatFromList" })}>
					New Chat
				</VSCodeButton>
			</div>

			{openRows.length > 0 && (
				<div className="px-4 pb-2">
					<div className="mb-1 text-xs uppercase tracking-wide opacity-60">Open now</div>
					{openRows.map((chat) => (
						<button
							className="mb-1 flex w-full items-center gap-2 rounded border-none bg-[var(--vscode-list-hoverBackground)] px-2 py-1.5 text-left text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-activeSelectionBackground)]"
							key={chat.sessionId}
							onClick={() => openSession(chat.sessionId)}
							type="button">
							<span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm">{chat.title}</span>
							<span className="shrink-0 text-xs opacity-60">{chat.location}</span>
						</button>
					))}
				</div>
			)}

			{/* Stock history, reused whole. `hideDone` because this list is a destination in its
			    own right — there is nothing to return to. */}
			<div className="min-h-0 flex-1">
				<HistoryView embedded hideDone onSelectTask={openSession} />
			</div>
		</div>
	)
}

export default SessionsListView
