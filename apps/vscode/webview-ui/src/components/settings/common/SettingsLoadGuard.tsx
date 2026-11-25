import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { type ReactNode, useEffect, useState } from "react"
import { retrySettingsLoad, SETTINGS_LOADING_NOTICE_MS, useSettingsHealth } from "@/utils/settingsHealth"

const Problem = ({ children }: { children: ReactNode }) => (
	<div className="mb-3 flex items-start gap-2 rounded-xs border border-error px-2 py-1.5 text-xs text-error" role="alert">
		<div className="flex-1">{children}</div>
		<VSCodeButton appearance="secondary" onClick={retrySettingsLoad}>
			Retry
		</VSCodeButton>
	</div>
)

/**
 * A failed load must never look like an empty setting. While a load has failed the fields are
 * not rendered, so nothing can be saved over a value the panel could not read.
 */
export const SettingsLoadGuard = ({ children }: { children: ReactNode }) => {
	const { loadFailed, loadsInProgress, slowModelLists, saveFailures, retryCount } = useSettingsHealth()
	const loading = loadsInProgress > 0
	const [showLoading, setShowLoading] = useState(false)

	useEffect(() => {
		if (!loading) {
			setShowLoading(false)
			return
		}
		const timer = setTimeout(() => setShowLoading(true), SETTINGS_LOADING_NOTICE_MS)
		return () => clearTimeout(timer)
	}, [loading])

	if (loadFailed) {
		return (
			<Problem>
				Couldn't load your settings. Nothing has been changed.
				{retryCount > 0 && " If this keeps happening, run Developer: Reload Window."}
			</Problem>
		)
	}

	return (
		<>
			{saveFailures.length > 0 && <Problem>{saveFailures.map((field) => `Couldn't save ${field}.`).join(" ")}</Problem>}
			{slowModelLists.length > 0 && <Problem>The model list is taking longer than expected.</Problem>}
			{showLoading && loading && (
				<p className="text-xs text-muted-foreground" role="status">
					Loading your settings…
				</p>
			)}
			{/* Hidden rather than unmounted, so the requests in progress can finish. */}
			<div hidden={showLoading && loading} key={retryCount}>
				{children}
			</div>
		</>
	)
}
