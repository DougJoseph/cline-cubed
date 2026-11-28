import { RELAY_UNREACHABLE_PREFIX } from "@shared/ExtensionMessage"
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
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { FileServiceClient, RemoteControlServiceClient } from "@/services/grpc-client"
import {
	DeviceIcon,
	deviceBrowser,
	deviceSeenRecently,
	deviceShortName,
	formatSeconds,
	Led,
	type LedColor,
} from "./remoteControlParts"

/** The reveal button, named the way the platform names it. */
const REVEAL_LABEL = navigator.platform.toLowerCase().includes("mac")
	? "Show in Finder"
	: navigator.platform.toLowerCase().includes("win")
		? "Show in File Explorer"
		: "Show in Folder"

/**
 * What Get installer just wrote: the folder, the files, and the token the install page asks for, and
 * the host of a relay already installed at the Relay URL ("" when none), which is updated instead.
 */
type SavedInstaller = { folder: string; files: string[]; token: string; updateHost: string }

const STATE_LABEL: Record<string, string> = {
	disconnected: "Off",
	connecting: "Connecting…",
	connected: "Active",
	failed: "Failed",
}

/** The power row's label beside its switch and LED. */
const POWER_LABEL: Record<string, string> = {
	disconnected: "Off",
	connecting: "Connecting…",
	connected: "On",
	failed: "Failed",
}

const POWER_LED: Record<string, LedColor> = {
	disconnected: "off",
	connecting: "busy",
	connected: "on",
	failed: "fault",
}

/** The one-line summary of a relay notice; the same words as the relay box's titles in `remoteControlManager.ts`. */
const NOTICE_SUMMARY: Record<string, string> = {
	"update-needed": "One update needed",
	behind: "Behind, automatic updates off",
	"update-failed": "Automatic update failed",
}

/** How often the open popover asks the relay for its devices again, so their lights stay current. */
const DEVICE_REFRESH_MS = 30_000

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
	// The parts that open and close. Relay settings follows the relay (open until it connects) unless
	// opened or closed by hand; Get installer's two parts follow whether a relay is installed.
	const [relayDetailsOpen, setRelayDetailsOpen] = useState(false)
	const [noticeOpen, setNoticeOpen] = useState(false)
	const [settingsOpenChoice, setSettingsOpenChoice] = useState<boolean>()
	const [updateStepsOpen, setUpdateStepsOpen] = useState(true)
	const [installStepsOpen, setInstallStepsOpen] = useState(true)
	// The popup dedicated to the paired devices; `focusId` is the device whose tile opened it, "" for See all.
	const [devicesPanel, setDevicesPanel] = useState<{ focusId: string }>()
	const devicesPanelRef = useRef<HTMLDivElement>(null)
	// The clock the device lights are read against, moved on with each device listing.
	const [nowMs, setNowMs] = useState(() => Date.now())
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

	// Saved on its own, the moment it changes: it is a choice, not a field typed with the others.
	const saveAutoUpdate = useCallback(
		async (autoUpdate: boolean) => {
			if (relaySettings && relaySettings.autoUpdate === autoUpdate) {
				return
			}
			try {
				const result = await RemoteControlServiceClient.setRelaySettings(RelaySettingsRequest.create({ autoUpdate }))
				if (result.error) {
					setRelayNote(result.error)
				}
			} catch (error) {
				console.error("Failed to save the relay update setting:", error)
				setRelayNote("Could not reach the extension.")
			}
		},
		[relaySettings],
	)

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
			// The steps show inside Relay settings, so it opens; the update steps lead when a relay is installed.
			setSettingsOpenChoice(true)
			setUpdateStepsOpen(true)
			setInstallStepsOpen(!result.installedRelayHost)
			setInstaller({
				folder: result.path,
				files: result.files,
				token: result.installToken,
				updateHost: result.installedRelayHost,
			})
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

	// The power row's light, and the relay row's light and words.
	const powerLed = POWER_LED[state] ?? "off"
	const relayHost =
		status?.relayHost ||
		(() => {
			try {
				return relaySettings?.url ? new URL(relaySettings.url).host : ""
			} catch {
				return relaySettings?.url ?? ""
			}
		})()
	const relayLed: LedColor = !status?.enabled
		? "idle"
		: relayCannotSave
			? "fault"
			: relayConnected
				? "on"
				: status?.relayState === "connecting"
					? "busy"
					: "fault"
	const relayLabel = relayCannotSave
		? "Relay can't save its data"
		: status?.enabled && relayConnected
			? "Relay connected"
			: status?.enabled && status?.relayState === "connecting"
				? "Relay connecting"
				: "Relay not connected"
	// No answer from the relay at all: the popover says so in its own words, and the system's text goes
	// to the relay details.
	const relayUnreachable = Boolean(status?.relayError?.startsWith(RELAY_UNREACHABLE_PREFIX))
	const relayErrorLine = relayUnreachable
		? `Cannot reach the relay at ${relayHost || "its address"}.`
		: status?.relayError
			? `Relay ${status.relayState}: ${status.relayError}`
			: ""
	const relaySystemText = relayUnreachable ? (status?.relayError ?? "").slice(RELAY_UNREACHABLE_PREFIX.length) : ""
	// A device reaches the chat only through the relay, so no device is connected while the relay is not.
	const deviceLink = (device: PairedDevice): { lit: boolean; text: string } =>
		!relayConnected
			? { lit: false, text: "not connected — relay is down" }
			: deviceSeenRecently(device.lastSeenAt, nowMs)
				? { lit: true, text: "connected now" }
				: { lit: false, text: "not seen in the last 2 minutes" }
	// Relay settings stays open until the relay connects, and while it has an error, unless opened or
	// closed by hand.
	const settingsOpen = settingsOpenChoice ?? (!relayConnected || Boolean(status?.relayError))

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

	// The error a device listing left in the pairing note, so the next listing that succeeds clears it
	// (a listing made while the relay was reconnecting must not leave "not connected" under a connected
	// relay). Errors from pairing itself are not touched.
	const listingErrorRef = useRef("")
	const takeListing = useCallback((result: { devices: typeof devices; error: string }) => {
		setDevices(result.devices)
		setNowMs(Date.now())
		if (result.error) {
			listingErrorRef.current = result.error
			setPairNote(result.error)
		} else if (listingErrorRef.current) {
			const stale = listingErrorRef.current
			listingErrorRef.current = ""
			setPairNote((note) => (note === stale ? "" : note))
		}
	}, [])

	const refreshDevices = useCallback(() => {
		RemoteControlServiceClient.listPairedDevices(EmptyRequest.create({}))
			.then(takeListing)
			.catch((error) => console.error("Failed to list paired devices:", error))
	}, [takeListing])

	useEffect(() => {
		if (!isVisible || !relayConnected) {
			return
		}
		refreshDevices()
		// Asked again while the popover stays open, so a device's light follows it connecting or leaving.
		const again = setInterval(refreshDevices, DEVICE_REFRESH_MS)
		return () => clearInterval(again)
	}, [isVisible, relayConnected, refreshDevices])

	// The devices popup closes on Escape, on a click outside it, and with the Remote Control popover; opened
	// from a tile, it brings that device into view.
	useEffect(() => {
		if (!devicesPanel) {
			return
		}
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setDevicesPanel(undefined)
			}
		}
		document.addEventListener("keydown", onKey)
		if (devicesPanel.focusId) {
			devicesPanelRef.current
				?.querySelector(`[data-device-id="${devicesPanel.focusId}"]`)
				?.scrollIntoView({ block: "nearest" })
		}
		return () => document.removeEventListener("keydown", onKey)
	}, [devicesPanel])
	useClickAway(devicesPanelRef, () => {
		if (devicesPanel && !pairing) {
			setDevicesPanel(undefined)
		}
	})
	useEffect(() => {
		if (!isVisible) {
			setDevicesPanel(undefined)
		}
	}, [isVisible])

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
					$sideInset={16}
					data-testid="remote-control-popover">
					{/* The top bar never scrolls, so the power switch is always in reach. While the devices popup
					    is open, the popover shows only it, so the popover is as tall as the device list needs. */}
					<div
						className={`flex-shrink-0 px-4 pt-3 pb-3 border-b border-[var(--vscode-editorGroup-border)] ${devicesPanel ? "hidden" : ""}`}>
						<div className="flex justify-between items-center mb-3">
							<div className="flex items-center gap-1.5">
								<div className="m-0 text-sm font-medium">Remote Control</div>
								<Tooltip>
									<TooltipTrigger asChild>
										<span
											aria-label="About Remote Control"
											className="codicon codicon-info text-[12px] text-muted-foreground cursor-default"
											data-testid="remote-control-info"
											role="img"
										/>
									</TooltipTrigger>
									<TooltipContent className="max-w-[260px]">
										Remote control keeps this chat running on this machine. A paired device talks to the
										relay, never to this computer.
									</TooltipContent>
								</Tooltip>
							</div>
							<VSCodeButton
								appearance="icon"
								aria-label="Close remote control popover"
								data-testid="remote-control-close"
								onClick={() => setIsVisible(false)}>
								<span className="codicon codicon-close text-[10px]" />
							</VSCodeButton>
						</div>
						<div className="flex items-center gap-2" title={label}>
							<Switch
								aria-label={status?.enabled ? "Turn remote control off" : "Turn remote control on"}
								checked={Boolean(status?.enabled)}
								data-testid="remote-control-toggle"
								disabled={busy}
								onCheckedChange={() => void toggle()}
								size="lg"
							/>
							<Led color={powerLed} testId="remote-control-power-led" />
							<span className="text-xs" data-testid="remote-control-state">
								{POWER_LABEL[state] ?? label}
							</span>
						</div>
					</div>

					{/* Everything else scrolls as one, under the top bar. */}
					<div
						className={`flex-1 min-h-0 overflow-y-auto px-4 pt-4 pb-4 ${devicesPanel ? "hidden" : ""}`}
						data-testid="remote-control-body">
						{relayHost ? (
							<div className="mb-4" data-testid="remote-control-relay">
								<button
									aria-expanded={relayDetailsOpen}
									className="flex w-full items-center gap-2 bg-transparent border-0 p-0 text-left text-xs text-[var(--vscode-foreground)] cursor-pointer"
									data-testid="remote-control-relay-toggle"
									onClick={() => setRelayDetailsOpen((open) => !open)}
									type="button">
									<span
										className={`codicon codicon-chevron-${relayDetailsOpen ? "down" : "right"} text-[11px]`}
									/>
									<Led color={relayLed} testId="remote-control-relay-led" />
									<span className="shrink-0" data-testid="remote-control-relay-state">
										{relayLabel}
									</span>
									<span
										className="min-w-0 flex-1 truncate rounded-sm border border-[var(--vscode-editorGroup-border)] px-1.5 py-0.5 font-mono"
										data-testid="remote-control-relay-host"
										title={relaySettings?.url || relayHost}>
										{relayHost}
									</span>
								</button>
								{relayErrorLine ? (
									<div
										className="text-xs text-error mt-1 select-all wrap-anywhere"
										data-testid="remote-control-relay-error">
										{relayErrorLine}
									</div>
								) : null}
								{relayDetailsOpen ? (
									<div
										className="mt-1.5 ml-5 flex flex-col gap-1 text-xs text-muted-foreground select-all"
										data-testid="remote-control-relay-details">
										{relaySystemText ? (
											<div className="wrap-anywhere" data-testid="remote-control-relay-system-text">
												What the system reported: {relaySystemText}
											</div>
										) : null}
										{relaySettings?.url ? (
											<div className="wrap-anywhere">Relay URL: {relaySettings.url}</div>
										) : null}
										{status?.relayDataDir ? (
											<div className="wrap-anywhere" data-testid="remote-control-relay-data">
												Relay data: {status.relayDataDir}. Delete that folder to install the relay again
												from scratch.
											</div>
										) : null}
										{status?.relayInstalledVersion ? (
											<div data-testid="remote-control-relay-installed">
												Installed base (index.php): v{status.relayInstalledVersion}
											</div>
										) : null}
										{status?.relayDisplayVersion ? (
											<div data-testid="remote-control-relay-display">
												Chat display code: v{status.relayDisplayVersion} (
												{status.relayDisplaySource === "sent"
													? "auto-updated by Cline Cubed"
													: "from the installed base"}
												)
											</div>
										) : null}
									</div>
								) : null}
							</div>
						) : null}

						{status?.relayNotice ? (
							<div className="mb-4 text-xs" data-testid="remote-control-relay-notice">
								<div className="flex items-center gap-2">
									<button
										aria-expanded={noticeOpen}
										className="flex min-w-0 flex-1 items-center gap-1.5 bg-transparent border-0 p-0 text-left text-xs text-warning cursor-pointer"
										data-testid="remote-control-relay-notice-toggle"
										onClick={() => setNoticeOpen((open) => !open)}
										type="button">
										<span
											className={`codicon codicon-chevron-${noticeOpen ? "down" : "right"} text-[11px]`}
										/>
										<span className="truncate">
											{NOTICE_SUMMARY[status.relayNoticeKind] ?? "Relay notice"}
										</span>
									</button>
									{status.relayNoticeKind === "update-needed" || status.relayNoticeKind === "behind" ? (
										<VSCodeButton
											appearance="secondary"
											data-testid="remote-control-relay-notice-installer"
											disabled={busy}
											onClick={exportBundle}>
											Get installer
										</VSCodeButton>
									) : null}
								</div>
								{noticeOpen ? (
									<div
										className="mt-1 ml-5 text-warning select-all"
										data-testid="remote-control-relay-notice-text">
										{status.relayNotice}
									</div>
								) : null}
							</div>
						) : null}

						{chatId ? (
							<VSCodeCheckbox
								checked={chatShared}
								className="mb-4"
								data-testid="remote-control-share-chat"
								disabled={!status?.enabled}
								onChange={(event) => setShared((event.target as HTMLInputElement).checked)}>
								Share this chat with my devices
							</VSCodeCheckbox>
						) : null}

						<div className="mb-4 text-xs" data-testid="remote-control-devices">
							<div className="flex items-center gap-1.5 mb-1.5">
								<div className="font-medium flex-1">Paired devices ({devices.length})</div>
								<VSCodeButton
									appearance="secondary"
									data-testid="remote-control-pair"
									disabled={!relayConnected}
									onClick={() => void pairDevice()}>
									Pair a device
								</VSCodeButton>
								<VSCodeButton
									appearance="secondary"
									data-testid="remote-control-devices-see-all"
									disabled={devices.length === 0}
									onClick={() => setDevicesPanel({ focusId: "" })}>
									See all
								</VSCodeButton>
							</div>
							{devices.length === 0 ? (
								<div className="text-muted-foreground mb-1">No device is paired.</div>
							) : (
								<div className="flex flex-wrap gap-1.5" data-testid="remote-control-device-grid">
									{devices.map((device) => {
										const link = deviceLink(device)
										return (
											<Tooltip key={device.id}>
												<TooltipTrigger asChild>
													<button
														aria-label={`${deviceShortName(device.name)}, ${link.text}. Show all paired devices.`}
														className="relative flex w-16 flex-col items-center gap-1 rounded-sm border border-[var(--vscode-editorGroup-border)] bg-transparent px-1 py-1.5 text-[var(--vscode-foreground)] cursor-pointer hover:bg-[var(--vscode-list-hoverBackground)]"
														data-testid="remote-control-device-tile"
														onClick={() => setDevicesPanel({ focusId: device.id })}
														type="button">
														<Led
															className="absolute right-1 top-1"
															color={link.lit ? "on" : "unseen"}
														/>
														<DeviceIcon name={device.name} />
														<span className="w-full truncate text-center text-[11px]">
															{deviceShortName(device.name)}
														</span>
													</button>
												</TooltipTrigger>
												<TooltipContent
													className="max-w-[280px]"
													data-testid="remote-control-device-tooltip">
													<div className="wrap-anywhere">{device.name || "Unnamed device"}</div>
													<div>Paired: {formatSeconds(device.createdAt)}</div>
													<div>Last seen: {formatSeconds(device.lastSeenAt)}</div>
													<div>{link.text.charAt(0).toUpperCase() + link.text.slice(1)}</div>
												</TooltipContent>
											</Tooltip>
										)
									})}
								</div>
							)}
							{!relayConnected ? (
								<div className="text-muted-foreground mt-1">Pairing needs the relay connected.</div>
							) : null}
							{pairNote ? <div className="text-error mt-1">{pairNote}</div> : null}
						</div>

						<div className="text-xs" data-testid="remote-control-relay-settings">
							<button
								aria-expanded={settingsOpen}
								className="flex w-full items-center gap-1.5 bg-transparent border-0 p-0 mb-1.5 text-left text-xs font-medium text-[var(--vscode-foreground)] cursor-pointer"
								data-testid="remote-control-relay-settings-toggle"
								onClick={() => setSettingsOpenChoice(!settingsOpen)}
								type="button">
								<span className={`codicon codicon-chevron-${settingsOpen ? "down" : "right"} text-[11px]`} />
								Relay settings
							</button>
							{settingsOpen ? (
								<div className="flex flex-col gap-1.5">
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
									<VSCodeCheckbox
										checked={relaySettings?.autoUpdate !== false}
										data-testid="relay-auto-update"
										disabled={busy}
										onChange={(event) => void saveAutoUpdate((event.target as HTMLInputElement).checked)}>
										Keep the relay up to date automatically
									</VSCodeCheckbox>
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
										<div
											className="text-xs text-muted-foreground whitespace-pre-line"
											data-testid="relay-note">
											{relaySettings?.error || relayNote}
										</div>
									) : null}
									{installer ? (
										<div className="flex flex-col gap-1.5 text-xs" data-testid="relay-installer">
											<div className="text-muted-foreground wrap-anywhere">
												Installer saved: index.php and INSTALL.txt in {installer.folder}
											</div>
											{installer.updateHost ? (
												<div>
													<button
														aria-expanded={updateStepsOpen}
														className="flex items-center gap-1.5 bg-transparent border-0 p-0 text-left text-xs font-medium text-[var(--vscode-foreground)] cursor-pointer"
														data-testid="relay-installer-update-toggle"
														onClick={() => setUpdateStepsOpen((open) => !open)}
														type="button">
														<span
															className={`codicon codicon-chevron-${updateStepsOpen ? "down" : "right"} text-[11px]`}
														/>
														Updating this relay
													</button>
													{updateStepsOpen ? (
														<div className="mt-1 ml-5" data-testid="relay-installer-update">
															Updating the relay at {installer.updateHost}: upload index.php over
															the old one; nothing else; your relay key and paired devices stay
														</div>
													) : null}
												</div>
											) : null}
											<div>
												<button
													aria-expanded={installStepsOpen}
													className="flex items-center gap-1.5 bg-transparent border-0 p-0 text-left text-xs font-medium text-[var(--vscode-foreground)] cursor-pointer"
													data-testid="relay-installer-install-toggle"
													onClick={() => setInstallStepsOpen((open) => !open)}
													type="button">
													<span
														className={`codicon codicon-chevron-${installStepsOpen ? "down" : "right"} text-[11px]`}
													/>
													Installing on a new server
												</button>
												{installStepsOpen ? (
													<div
														className="mt-1 ml-5 flex flex-col gap-1.5"
														data-testid="relay-installer-install">
														<div>1. Upload index.php to a folder on your web server.</div>
														<div>2. Open that folder's URL in a browser.</div>
														<div>
															3. Copy this install token, paste it into the page, and press Install:
														</div>
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
																		<span className="text-error font-semibold">
																			Copy failed
																		</span>
																	) : (
																		"Copy"
																	)}
																</span>
															</VSCodeButton>
														</div>
														<div>
															4. Copy the credential the page shows into the Relay key field above,
															then Save relay.
														</div>
													</div>
												) : null}
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
							) : null}
						</div>
					</div>

					{devicesPanel ? (
						<div
							className="flex min-h-0 flex-1 flex-col"
							data-testid="remote-control-devices-panel"
							ref={devicesPanelRef}>
							<div className="flex flex-shrink-0 items-center gap-1.5 px-4 pt-3 pb-3 border-b border-[var(--vscode-editorGroup-border)]">
								<div className="flex-1 text-sm font-medium">Paired devices ({devices.length})</div>
								<VSCodeButton appearance="secondary" disabled={!relayConnected} onClick={() => void pairDevice()}>
									Pair a device
								</VSCodeButton>
								<VSCodeButton
									appearance="icon"
									aria-label="Close the paired devices"
									data-testid="remote-control-devices-panel-close"
									onClick={() => setDevicesPanel(undefined)}>
									<span className="codicon codicon-close" />
								</VSCodeButton>
							</div>
							<div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 text-xs">
								{devices.length === 0 ? <div className="text-muted-foreground">No device is paired.</div> : null}
								{devices.map((device) => {
									const link = deviceLink(device)
									const browser = deviceBrowser(device.name)
									return (
										<div
											className={`flex items-start gap-2 rounded-sm p-1.5 mb-1 ${
												devicesPanel.focusId === device.id
													? "ring-1 ring-[var(--vscode-focusBorder)]"
													: ""
											}`}
											data-device-id={device.id}
											data-testid="remote-control-device-row"
											key={device.id}>
											<div className="relative shrink-0 pt-0.5">
												<DeviceIcon name={device.name} size={20} />
												<Led className="absolute -right-1 -top-0.5" color={link.lit ? "on" : "unseen"} />
											</div>
											<div className="min-w-0 flex-1">
												<div className="font-medium">
													{deviceShortName(device.name)}
													{browser ? ` · ${browser}` : ""} — {link.text}
												</div>
												<div className="text-muted-foreground wrap-anywhere select-all">
													{device.name || "Unnamed device"}
												</div>
												<div className="text-muted-foreground">
													Paired: {formatSeconds(device.createdAt)}
												</div>
												<div className="text-muted-foreground">
													Last seen: {formatSeconds(device.lastSeenAt)}
												</div>
											</div>
											<VSCodeButton appearance="secondary" onClick={() => removeDevice(device.id)}>
												Remove
											</VSCodeButton>
										</div>
									)
								})}
							</div>
						</div>
					) : null}

					{pairing ? (
						<div
							className="absolute left-4 right-4 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-1.5 rounded-sm border border-[var(--vscode-focusBorder)] bg-[var(--vscode-editorWidget-background)] p-3 shadow-lg text-xs"
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
								className="text-muted-foreground select-all wrap-anywhere"
								data-testid="remote-control-pairing-link">
								{pairing.link}
							</div>
							<div className="text-muted-foreground">
								Works once, until {new Date(pairing.expiresAt).toLocaleTimeString()}.
							</div>
						</div>
					) : null}
				</PopupModalContainer>
			)}
		</div>
	)
}

export default RemoteControlToggle
