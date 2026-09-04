import type { Boolean, EmptyRequest } from "@shared/proto/cline/common"
import { useCallback, useEffect } from "react"
import AccountView from "./components/account/AccountView"
import ChatView from "./components/chat/ChatView"
import WhatsNewModal from "./components/common/WhatsNewModal"
import HistoryView from "./components/history/HistoryView"
import MarketplaceView from "./components/marketplace/MarketplaceView"
import McpView from "./components/mcp/configuration/McpConfigurationView"
import { openClinePassSubscriptionIfPending } from "./components/onboarding/clinePassSubscribe"
import OnboardingView from "./components/onboarding/OnboardingView"
import SessionsListView from "./components/sessions/SessionsListView"
import SettingsView from "./components/settings/SettingsView"
import WorktreesView from "./components/worktrees/WorktreesView"
import { PLATFORM_CONFIG } from "./config/platform.config"
import { useClineAuth } from "./context/ClineAuthContext"
import { useExtensionState } from "./context/ExtensionStateContext"
import { Providers } from "./Providers"
import { UiServiceClient } from "./services/grpc-client"

const AppContent = () => {
	const {
		didHydrateState,
		showWelcome,
		clineCubedShowOnboarding,
		dismissOnboardingHere,
		shouldShowAnnouncement,
		showMarketplace,
		showMcp,
		mcpTab,
		showSettings,
		settingsTargetSection,
		showHistory,
		showAccount,
		showWorktrees,
		showAnnouncement,
		setShowAnnouncement,
		setShouldShowAnnouncement,
		closeMcpView,
		navigateToHistory,
		hideSettings,
		hideHistory,
		hideAccount,
		hideWorktrees,
		closeMarketplaceView,
		version,
		whatsNewNotes,
	} = useExtensionState()

	const { clineUser, organizations, activeOrganization } = useClineAuth()

	// Cline Cubed: the What's New modal opens in whichever chat view is on screen, and the version
	// is recorded as seen only when the modal is CLOSED. Stock acknowledged the announcement the
	// moment it was flagged and rendered the modal only on the chat home, so with a chat open the
	// notes were marked seen without ever appearing. Every open chat surface is its own webview
	// and shows the modal; closing it in one records the acknowledgment, the extension pushes the
	// state to every surface, and the effect below closes the rest.
	useEffect(() => {
		if (!didHydrateState || showWelcome) {
			return
		}
		setShowAnnouncement(shouldShowAnnouncement)
	}, [didHydrateState, showWelcome, shouldShowAnnouncement, setShowAnnouncement])

	const closeWhatsNew = useCallback(() => {
		setShowAnnouncement(false)
		UiServiceClient.onDidShowAnnouncement({} as EmptyRequest)
			.then((response: Boolean) => {
				setShouldShowAnnouncement(response.value)
			})
			.catch((error) => {
				console.error("Failed to acknowledge announcement:", error)
			})
	}, [setShouldShowAnnouncement, setShowAnnouncement])

	// Open the ClinePass subscription page once auth completes. Lives here (not in OnboardingView)
	// because handleAuthCallback unmounts onboarding before the clineUser update arrives.
	useEffect(() => {
		if (clineUser?.uid) {
			openClinePassSubscriptionIfPending(clineUser.appBaseUrl)
		}
	}, [clineUser?.uid, clineUser?.appBaseUrl])

	if (!didHydrateState) {
		return null
	}

	// Cline Cubed: the primary container's webview renders the CHATS LIST, not a chat. Returned
	// before ChatView, which is deliberately never unmounted below and would otherwise make this
	// surface a second chat.
	if (window.__CLINE_CUBED_VIEW_KIND__ === "sessions") {
		return <SessionsListView />
	}

	if (showWelcome || clineCubedShowOnboarding) {
		return (
			<OnboardingView
				onDismiss={
					clineCubedShowOnboarding && !showWelcome
						? () => {
								dismissOnboardingHere()
								PLATFORM_CONFIG.postMessage({ type: "dismissOnboarding" })
							}
						: undefined
				}
			/>
		)
	}

	return (
		<div className="flex h-screen w-full flex-col">
			{showSettings && <SettingsView onDone={hideSettings} targetSection={settingsTargetSection} />}
			{showHistory && <HistoryView onDone={hideHistory} />}
			{showMarketplace && <MarketplaceView initialType={mcpTab ? "mcp" : undefined} onDone={closeMarketplaceView} />}
			{showMcp && <McpView initialTab={mcpTab} onDone={closeMcpView} />}
			{showAccount && (
				<AccountView
					activeOrganization={activeOrganization}
					clineUser={clineUser}
					onDone={hideAccount}
					organizations={organizations}
				/>
			)}
			{showWorktrees && <WorktreesView onDone={hideWorktrees} />}
			<WhatsNewModal
				notes={whatsNewNotes ?? ""}
				onClose={closeWhatsNew}
				open={showAnnouncement && !!whatsNewNotes}
				version={version}
			/>
			{/* Do not conditionally load ChatView, it's expensive and there's state we don't want to lose (user input, disableInput, askResponse promise, etc.) */}
			<ChatView
				isHidden={showSettings || showHistory || showMarketplace || showMcp || showAccount || showWorktrees}
				showHistoryView={navigateToHistory}
			/>
		</div>
	)
}

const App = () => {
	return (
		<Providers>
			<AppContent />
		</Providers>
	)
}

export default App
