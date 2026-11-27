import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import {
	ChatShareRequest,
	type PairedDevice,
	RelaySettingsRequest,
	type RemoteControlStatus,
} from "@shared/proto/cline/remote_control"
import { VSCodeButton, VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { Smartphone } from "lucide-react"
import QRCode from "qrcode"
import React, { useCallback, useEffect, useRef, useState } from "react"
import { useClickAway, useWindowSize } from "react-use"
import PopupModalContainer from "@/components/common/PopupModalContainer"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { FileServiceClient, RemoteControlServiceClient } from "@/services/grpc-client"

/** The reveal button, named the way the platform names it. */
const REVEAL_LABEL = navigator.platform.toLowerCase().includes("mac")
	? "Show in Finder"
	: navigator.platform.toLowerCase().includes("win")
		? "Show in File Explorer"
		: "Show in Folder"

/** What Get installer just wrote: the folder, the files, and the token the install page asks for. */
type SavedInstaller = { folder: string; files: string[]; token: string }

const STATE_LABEL: Record<string, string> = {
	disconnected: "Off",
	connecting: "Connecting…",
	connected: "Active",
	failed: "Failed",
}

/**
 * The composer's remote-control affordance: one control carrying both jobs.
 *
 * Its glow is the active-mode badge — the state it shows is the confirmed state, never the one that
 * was requested — and clicking it opens the popover holding that state, the local URL, a named failure
 * when there is one, and the Turn on / Turn off action. `/remote-control` in the composer is the
 * keyboard path to the same toggle.
 */
const RemoteControlToggle: React.FC = () => {
	// The badge reads the state the host pushes with every snapshot, so it cannot lag a change made
	// from another surface or from the composer command. The RPC read is only a fallback for a
	// snapshot that carries nothing yet.
	const { remoteControl, relaySettings, currentTaskItem } = useExtensionState()
	const chatId = currentTaskItem?.id ?? ""
	const [pairing, setPairing] = useState<{ code: string; link: string; qr: string; expiresAt: number }>()
	const [pairNote, setPairNote] = useState("")
	const [devices, setDevices] = useState<PairedDevice[]>([])
	// The devices already paired when a code is shown, so a device that pairs with it can be noticed.
	const devicesRef = useRef<PairedDevice[]>([])
	devicesRef.current = devices
	const pairedBeforeCode = useRef<Set<string>>(new Set())
	const pairingRef = useRef<HTMLDivElement>(null)
	const [fetched, setFetched] = useState<RemoteControlStatus>()
	const status = remoteControl ?? fetched
	const [isVisible, setIsVisible] = useState(false)
	const [busy, setBusy] = useState(false)
	const [relayUrl, setRelayUrl] = useState("")
	const [relayKey, setRelayKey] = useState("")
	const [relayPoll, setRelayPoll] = useState("")
	const [relayNote, setRelayNote] = useState("")
	const [installer, setInstaller] = useState<SavedInstaller>()
	// "copied" and "failed" each show for a moment after a click, then the button reads "Copy" again,
	// so every click gives a visible answer.
	const [tokenCopy, setTokenCopy] = useState<"idle" | "copied" | "failed">("idle")
	const tokenCopyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	useEffect(() => () => clearTimeout(tokenCopyTimer.current), [])
	const buttonRef = useRef<HTMLDivElement>(null)
	const modalRef = useRef<HTMLDivElement>(null)
	const { width: viewportWidth, height: viewportHeight } = useWindowSize()
	const [arrowPosition, setArrowPosition] = useState(0)
	const [menuPosition, setMenuPosition] = useState(0)

	useEffect(() => {
		if (remoteControl) {
			return
		}
		RemoteControlServiceClient.getRemoteControlStatus(EmptyRequest.create({}))
			.then(setFetched)
			.catch((error) => console.error("Failed to read remote control state:", error))
	}, [remoteControl])

	useClickAway(modalRef, () => setIsVisible(false))

	useEffect(() => {
		if (!isVisible || !buttonRef.current) {
			return
		}
		const rect = buttonRef.current.getBoundingClientRect()
		setArrowPosition(document.documentElement.clientWidth - (rect.left + rect.width / 2) - 5)
		setMenuPosition(rect.top + 1)
	}, [isVisible, viewportHeight, viewportWidth])

	const toggle = useCallback(async () => {
		setBusy(true)
		try {
			// The host answers by pushing the new state to every surface; nothing is set locally here,
			// which is what keeps one surface's badge from disagreeing with another's.
			await RemoteControlServiceClient.toggleRemoteControl(EmptyRequest.create({}))
		} catch (error) {
			console.error("Failed to toggle remote control:", error)
		} finally {
			setBusy(false)
		}
	}, [])

	// Stored values seed the inputs. A value already typed is never overwritten by an incoming snapshot.
	useEffect(() => {
		if (!relaySettings) {
			return
		}
		setRelayUrl((current) => current || relaySettings.url)
		setRelayPoll((current) => current || String(relaySettings.pollIntervalMs))
	}, [relaySettings])

	const saveRelay = useCallback(async () => {
		setBusy(true)
		try {
			const request = RelaySettingsRequest.create({
				url: relayUrl.trim(),
				pollIntervalMs: Number.parseInt(relayPoll, 10) || undefined,
				...(relayKey.trim() ? { key: relayKey.trim() } : {}),
			})
			const result = await RemoteControlServiceClient.setRelaySettings(request)
			setRelayNote(result.error || "Saved.")
			// The credential is write-only: it is sent once and never read back into this surface.
			setRelayKey("")
		} catch (error) {
			console.error("Failed to save relay settings:", error)
			setRelayNote("Could not reach the extension.")
		} finally {
			setBusy(false)
		}
	}, [relayUrl, relayPoll, relayKey])

	const copyToken = useCallback(() => {
		if (!installer) {
			return
		}
		const show = (outcome: "copied" | "failed") => {
			clearTimeout(tokenCopyTimer.current)
			setTokenCopy(outcome)
			tokenCopyTimer.current = setTimeout(() => setTokenCopy("idle"), 2000)
		}
		FileServiceClient.copyToClipboard(StringRequest.create({ value: installer.token }))
			.then(() => show("copied"))
			.catch((error) => {
				console.error("Failed to copy the install token:", error)
				show("failed")
			})
	}, [installer])

	const revealInstaller = useCallback(() => {
		const target = installer?.files[0] || installer?.folder
		if (!target) {
			return
		}
		RemoteControlServiceClient.revealRelayInstaller(StringRequest.create({ value: target })).catch((error) =>
			console.error("Failed to show the installer:", error),
		)
	}, [installer])

	const exportBundle = useCallback(async () => {
		setBusy(true)
		try {
			const result = await RemoteControlServiceClient.exportRelayBundle(EmptyRequest.create({}))
			// A cancelled folder dialog writes nothing and says nothing.
			if (result.error === "cancelled") {
				return
			}
			if (result.error) {
				setInstaller(undefined)
				setRelayNote(`Export failed: ${result.error}`)
				return
			}
			setRelayNote("")
			clearTimeout(tokenCopyTimer.current)
			setTokenCopy("idle")
			setInstaller({ folder: result.path, files: result.files, token: result.installToken })
		} catch (error) {
			console.error("Failed to export the relay bundle:", error)
			setRelayNote("Could not export the relay files.")
		} finally {
			setBusy(false)
		}
	}, [])

	const hubState = status?.state ?? "disconnected"
	// A paired device reaches this machine only through the relay, so the mode is not active while the
	// relay has failed, even with the local hub running.
	const relayFailed = hubState === "connected" && Boolean(status?.relayError)
	const state = relayFailed ? "failed" : hubState
	const active = state === "connected"
	const relayConnected = status?.relayState === "connected"
	// Reached, but the relay reports it could not save its data: a different failure from not reaching it.
	const relayCannotSave = relayConnected && Boolean(status?.relayError?.startsWith("relay_save_failed"))

	// The saved installer's steps are finished work once the relay connects, so they step aside then;
	// Get installer shows them again.
	const wasRelayConnected = useRef(relayConnected)
	useEffect(() => {
		if (relayConnected && !wasRelayConnected.current) {
			setInstaller(undefined)
		}
		wasRelayConnected.current = relayConnected
	}, [relayConnected])
	const chatShared = Boolean(chatId && status?.sharedChats?.includes(chatId))

	const setShared = useCallback(
		(shared: boolean) => {
			if (!chatId) {
				return
			}
			RemoteControlServiceClient.setChatShared(ChatShareRequest.create({ sessionId: chatId, shared })).catch((error) =>
				console.error("Failed to change whether this chat is shared:", error),
			)
		},
		[chatId],
	)

	const refreshDevices = useCallback(() => {
		RemoteControlServiceClient.listPairedDevices(EmptyRequest.create({}))
			.then((result) => {
				setDevices(result.devices)
				if (result.error) {
					setPairNote(result.error)
				}
			})
			.catch((error) => console.error("Failed to list paired devices:", error))
	}, [])

	useEffect(() => {
		if (isVisible && relayConnected) {
			refreshDevices()
		}
	}, [isVisible, relayConnected, refreshDevices])

	const pairDevice = useCallback(async () => {
		setPairNote("")
		try {
			const result = await RemoteControlServiceClient.createPairingCode(EmptyRequest.create({}))
			if (result.error || !result.code) {
				setPairing(undefined)
				setPairNote(result.error || "The relay did not return a code.")
				return
			}
			const link = `${result.pageUrl}#pair-${result.code}`
			const qr = await QRCode.toDataURL(link, { margin: 1, width: 192 })
			pairedBeforeCode.current = new Set(devicesRef.current.map((device) => device.id))
			setPairing({ code: result.code, link, qr, expiresAt: Date.now() + result.expiresInSeconds * 1000 })
		} catch (error) {
			setPairNote(error instanceof Error ? error.message : String(error))
		}
	}, [])

	const closePairing = useCallback(() => setPairing(undefined), [])

	// The pairing popover closes on Escape, when its code runs out, and once a device pairs with it;
	// a code that has done its job, or can no longer, has no reason to stay on screen.
	useEffect(() => {
		if (!pairing) {
			return
		}
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				closePairing()
			}
		}
		document.addEventListener("keydown", onKey)
		const expiry = setTimeout(closePairing, Math.max(0, pairing.expiresAt - Date.now()))
		const watch = setInterval(() => {
			RemoteControlServiceClient.listPairedDevices(EmptyRequest.create({}))
				.then((result) => {
					setDevices(result.devices)
					if (result.devices.some((device) => !pairedBeforeCode.current.has(device.id))) {
						closePairing()
					}
				})
				.catch((error) => console.error("Failed to list paired devices:", error))
		}, 2000)
		return () => {
			document.removeEventListener("keydown", onKey)
			clearTimeout(expiry)
			clearInterval(watch)
		}
	}, [pairing, closePairing])

	// A click outside the pairing popover closes it alone; the Remote Control popover stays open.
	useClickAway(pairingRef, () => {
		if (pairing) {
			closePairing()
		}
	})

	const removeDevice = useCallback((deviceId: string) => {
		RemoteControlServiceClient.removePairedDevice(StringRequest.create({ value: deviceId }))
			.then((result) => {
				setDevices(result.devices)
				if (result.error) {
					setPairNote(result.error)
				}
			})
			.catch((error) => console.error("Failed to remove a paired device:", error))
	}, [])

	const label = relayCannotSave
		? "On, but the relay cannot save its data"
		: relayFailed
			? "On, but the relay is not connected"
			: status?.error
				? `${STATE_LABEL[state]}: ${status.error}`
				: STATE_LABEL[state]

	return (
		<div className="inline-flex min-w-0 max-w-full items-center" ref={modalRef}>
			<div className="inline-flex w-full items-center" ref={buttonRef}>
				<Tooltip>
					{!isVisible && <TooltipContent>Remote Control — {label}</TooltipContent>}
					<TooltipTrigger>
						<VSCodeButton
							appearance="icon"
							aria-label={`Remote Control (${label})`}
							className={`p-0 m-0 flex items-center ${
								active
									? "text-success shadow-[0_0_6px_var(--vscode-charts-green)]"
									: state === "failed"
										? "text-error"
										: state === "connecting"
											? "text-warning animate-pulse"
											: ""
							}`}
							data-testid="remote-control-button"
							disabled={busy}
							onClick={() => setIsVisible(!isVisible)}>
							<Smartphone size={13} />
						</VSCodeButton>
					</TooltipTrigger>
				</Tooltip>
			</div>

			{isVisible && (
				<PopupModalContainer
					$arrowPosition={arrowPosition}
					$borderColor="var(--vscode-focusBorder)"
					$menuPosition={menuPosition}
					data-testid="remote-control-popover">
					<div className="flex-shrink-0 px-3 pt-2">
						<div className="flex justify-between items-center mb-2.5">
							<div className="m-0 text-sm font-medium">Remote Control</div>
							<VSCodeButton
								appearance="icon"
								aria-label="Close remote control popover"
								data-testid="remote-control-close"
								onClick={() => setIsVisible(false)}>
								<span className="codicon codicon-close text-[10px]" />
							</VSCodeButton>
						</div>
					</div>

					<div className="flex-1 px-3 pb-3">
						<div className="text-xs text-muted-foreground mb-1" data-testid="remote-control-state">
							{label}
						</div>
						{status?.relayState ? (
							<div
								className={`text-xs mb-1 select-all ${status.relayError ? "text-error" : "text-muted-foreground"}`}
								data-testid="remote-control-relay-state">
								{status.relayError
									? `Relay ${status.relayState}: ${status.relayError}`
									: `Relay ${status.relayState} — ${status.relayHost}`}
							</div>
						) : null}
						{status?.relayDataDir ? (
							<div
								className="text-xs text-muted-foreground mb-1 select-all"
								data-testid="remote-control-relay-data">
								Relay data: {status.relayDataDir}. Delete that folder to install the relay again from scratch.
							</div>
						) : null}
						<p className="text-xs text-muted-foreground mb-2">
							Remote control keeps this chat running on this machine. A paired device talks to the relay, never to
							this computer.
						</p>
						{chatId ? (
							<VSCodeCheckbox
								checked={chatShared}
								className="mb-2"
								data-testid="remote-control-share-chat"
								disabled={!status?.enabled}
								onChange={(event) => setShared((event.target as HTMLInputElement).checked)}>
								Share this chat with my devices
							</VSCodeCheckbox>
						) : null}
						<div className="flex flex-col gap-1.5 mb-2">
							<VSCodeTextField
								data-testid="relay-url-input"
								onInput={(event) => setRelayUrl((event.target as HTMLInputElement).value)}
								placeholder="https://your-domain.com/relay"
								value={relayUrl}>
								<span className="text-xs text-muted-foreground">Relay URL</span>
							</VSCodeTextField>
							<VSCodeTextField
								className="[&::part(root)]:border-[var(--vscode-focusBorder)]"
								data-testid="relay-key-input"
								onInput={(event) => setRelayKey((event.target as HTMLInputElement).value)}
								placeholder={
									relaySettings?.hasKey
										? `Stored (${relaySettings.keyMasked}) — paste to replace`
										: "From the relay's install page"
								}
								value={relayKey}>
								<span className="text-xs text-muted-foreground">Relay key</span>
							</VSCodeTextField>
							<VSCodeTextField
								data-testid="relay-poll-input"
								onInput={(event) => setRelayPoll((event.target as HTMLInputElement).value)}
								placeholder="1500"
								value={relayPoll}>
								<span className="text-xs text-muted-foreground">Poll interval (ms)</span>
							</VSCodeTextField>
							<div className="flex gap-1.5 items-center">
								<VSCodeButton data-testid="relay-save" disabled={busy} onClick={saveRelay}>
									Save relay
								</VSCodeButton>
								<VSCodeButton
									appearance="secondary"
									data-testid="relay-export"
									disabled={busy}
									onClick={exportBundle}>
									Get installer
								</VSCodeButton>
							</div>
							{relaySettings?.error || relayNote ? (
								<div className="text-xs text-muted-foreground whitespace-pre-line" data-testid="relay-note">
									{relaySettings?.error || relayNote}
								</div>
							) : null}
							{installer ? (
								<div className="flex flex-col gap-1.5 text-xs" data-testid="relay-installer">
									<div className="text-muted-foreground">
										Installer saved: index.php and INSTALL.txt in {installer.folder}
									</div>
									<div>1. Upload index.php to a folder on your web server.</div>
									<div>2. Open that folder's URL in a browser.</div>
									<div>3. Copy this install token, paste it into the page, and press Install:</div>
									<div className="flex gap-1.5 items-center">
										<input
											aria-label="Install token"
											className="flex-1 min-w-0 rounded-sm border border-[var(--vscode-focusBorder)] bg-input-background p-1 text-sm text-input-foreground font-mono"
											data-testid="relay-install-token"
											onClick={(event) => event.currentTarget.select()}
											onFocus={(event) => event.currentTarget.select()}
											readOnly
											value={installer.token}
										/>
										<VSCodeButton
											appearance="secondary"
											className="shrink-0 min-w-[6.5rem]"
											data-testid="relay-install-token-copy"
											onClick={copyToken}>
											<span className="inline-flex w-full items-center justify-center gap-1 whitespace-nowrap">
												{tokenCopy === "copied" ? (
													<span className="inline-flex items-center gap-0.5 text-success font-semibold">
														<span className="codicon codicon-check text-[11px]" />
														Copied
													</span>
												) : tokenCopy === "failed" ? (
													<span className="text-error font-semibold">Copy failed</span>
												) : (
													"Copy"
												)}
											</span>
										</VSCodeButton>
									</div>
									<div>
										4. Copy the credential the page shows into the Relay key field above, then Save relay.
									</div>
									<div>
										<VSCodeButton
											appearance="secondary"
											data-testid="relay-installer-reveal"
											onClick={revealInstaller}>
											{REVEAL_LABEL}
										</VSCodeButton>
									</div>
								</div>
							) : null}
						</div>
						<div className="mb-3 text-xs" data-testid="remote-control-devices">
							<div className="font-medium mb-1">Paired devices</div>
							{devices.length === 0 ? (
								<div className="text-muted-foreground mb-1">No device is paired.</div>
							) : (
								devices.map((device) => (
									<div className="flex items-center gap-2 mb-1" key={device.id}>
										<span className="flex-1 min-w-0 truncate" title={device.name}>
											{device.name || "Unnamed device"}
										</span>
										<VSCodeButton appearance="secondary" onClick={() => removeDevice(device.id)}>
											Remove
										</VSCodeButton>
									</div>
								))
							)}
							<VSCodeButton
								appearance="secondary"
								data-testid="remote-control-pair"
								disabled={!relayConnected}
								onClick={() => void pairDevice()}>
								Pair a device
							</VSCodeButton>
							{!relayConnected ? (
								<div className="text-muted-foreground mt-1">Pairing needs the relay connected.</div>
							) : null}
							{pairing ? (
								<div
									className="absolute left-4 right-4 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1.5 rounded-sm border border-[var(--vscode-focusBorder)] bg-[var(--vscode-editorWidget-background)] p-3 shadow-lg"
									data-testid="remote-control-pairing-popover"
									ref={pairingRef}>
									<div className="flex items-start justify-between gap-2">
										<div>On the device, scan this code, or open the relay's address and enter the code:</div>
										<VSCodeButton
											appearance="icon"
											aria-label="Close the pairing code"
											data-testid="remote-control-pairing-close"
											onClick={closePairing}>
											<span className="codicon codicon-close" />
										</VSCodeButton>
									</div>
									<div className="flex items-center gap-3">
										<img
											alt={`QR code for ${pairing.link}`}
											className="rounded-sm bg-white p-1 w-32 h-32"
											src={pairing.qr}
										/>
										<div className="rounded-sm border border-[var(--vscode-focusBorder)] px-3 py-2 font-mono text-lg tracking-widest select-all">
											{pairing.code}
										</div>
									</div>
									<div
										className="text-muted-foreground select-all break-all"
										data-testid="remote-control-pairing-link">
										{pairing.link}
									</div>
									<div className="text-muted-foreground">
										Works once, until {new Date(pairing.expiresAt).toLocaleTimeString()}.
									</div>
								</div>
							) : null}
							{pairNote ? <div className="text-error mt-1">{pairNote}</div> : null}
						</div>
						<VSCodeButton data-testid="remote-control-toggle" disabled={busy} onClick={toggle}>
							{status?.enabled ? "Turn off" : "Turn on"}
						</VSCodeButton>
					</div>
				</PopupModalContainer>
			)}
		</div>
	)
}

export default RemoteControlToggle
