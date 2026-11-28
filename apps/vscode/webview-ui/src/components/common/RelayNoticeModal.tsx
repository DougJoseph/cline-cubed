import { EmptyRequest } from "@shared/proto/cline/common"
import { RelaySettingsRequest } from "@shared/proto/cline/remote_control"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { RemoteControlServiceClient } from "@/services/grpc-client"

/**
 * Cline Cubed: a Remote Control relay notice that needs the person's action, opened the moment the
 * extension finds it, like the What's New box. It stays until closed or acted on, and then tells the
 * extension it was seen, so it closes in every window and does not open again on this connection.
 * While another box is open (`held`, the What's New box), it stays closed; the extension keeps the
 * notice waiting, so it opens once that box is closed. One box is on screen at a time.
 */
const RelayNoticeModal = ({ held }: { held: boolean }) => {
	const { remoteControl } = useExtensionState()
	const title = remoteControl?.relayNoticePopupTitle ?? ""
	const notice = remoteControl?.relayNotice ?? ""
	const kind = remoteControl?.relayNoticeKind ?? ""
	const open = !held && title !== "" && notice !== ""

	const dismiss = () => {
		RemoteControlServiceClient.dismissRelayNotice(EmptyRequest.create({})).catch((error) =>
			console.error("Failed to dismiss the relay notice:", error),
		)
	}
	const getInstaller = () => {
		dismiss()
		RemoteControlServiceClient.exportRelayBundle(EmptyRequest.create({})).catch((error) =>
			console.error("Failed to get the relay installer:", error),
		)
	}
	const turnOnUpdates = () => {
		dismiss()
		RemoteControlServiceClient.setRelaySettings(RelaySettingsRequest.create({ autoUpdate: true })).catch((error) =>
			console.error("Failed to turn on automatic relay updates:", error),
		)
	}

	// Like the What's New box: it never takes focus from what the person is doing elsewhere.
	return (
		<Dialog modal={false} onOpenChange={(isOpen) => !isOpen && dismiss()} open={open}>
			{open && <div aria-hidden="true" className="fixed inset-0 z-50 bg-black/80" data-testid="relay-notice-backdrop" />}
			<DialogContent
				aria-describedby="relay-notice-description"
				aria-labelledby="relay-notice-title"
				className="pt-5 px-5 pb-4 gap-0"
				data-testid="relay-notice-popup"
				onCloseAutoFocus={(event) => event.preventDefault()}
				onOpenAutoFocus={(event) => event.preventDefault()}>
				<h2
					className="text-lg font-semibold mb-3 pr-6"
					data-testid="relay-notice-title"
					id="relay-notice-title"
					style={{ color: "var(--vscode-editor-foreground)" }}>
					{title}
				</h2>
				<p
					className="text-sm mb-4"
					id="relay-notice-description"
					style={{ color: "var(--vscode-descriptionForeground)" }}>
					{notice}
				</p>
				<div className="flex gap-2 justify-end">
					{kind === "behind" && (
						<VSCodeButton data-testid="relay-notice-turn-on" onClick={turnOnUpdates}>
							Turn on automatic updates
						</VSCodeButton>
					)}
					{(kind === "update-needed" || kind === "behind") && (
						<VSCodeButton
							appearance={kind === "behind" ? "secondary" : "primary"}
							data-testid="relay-notice-get-installer"
							onClick={getInstaller}>
							Get installer
						</VSCodeButton>
					)}
				</div>
			</DialogContent>
		</Dialog>
	)
}

export default RelayNoticeModal
