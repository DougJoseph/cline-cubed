import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import RemoteControlToggle from "./RemoteControlToggle"

/** What the extension pushes with every snapshot; a test changes it and renders again. */
const extensionState = {
	remoteControl: {
		state: "connected",
		enabled: true,
		error: "",
		relayState: "connected",
		relayError: "",
		relayHost: "relay.example",
		sharedChats: [] as string[],
		relayPageUrl: "https://relay.example/cline-cubed/",
		relayDataDir: "/home/relay/.cline-cubed-relay/abc",
		relayNotice: "",
	},
	relaySettings: {
		url: "https://relay.example/cline-cubed/",
		pollIntervalMs: 1500,
		hasKey: true,
		keyTail: "wxyz",
		autoUpdate: true,
		error: "",
	},
	currentTaskItem: { id: "chat-0001" },
}

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => extensionState,
}))

vi.mock("qrcode", () => ({
	default: { toDataURL: async () => "data:image/png;base64,AAAA" },
}))

/** The paired devices the relay answers with; a test adds one to stand for a phone that just paired. */
let pairedDevices: Array<{ id: string; name: string; createdAt: number; lastUsedAt: number }> = []
let pairingLifetimeSeconds = 600
/** The host of a relay already installed at the Relay URL, as the export reports it; "" for none. */
let installedRelayHost = ""

vi.mock("@/services/grpc-client", () => ({
	RemoteControlServiceClient: {
		getRemoteControlStatus: async () => extensionState.remoteControl,
		listPairedDevices: async () => ({ devices: [...pairedDevices], error: "" }),
		createPairingCode: async () => ({
			code: "ABCD-EFGH",
			pageUrl: "https://relay.example/cline-cubed/",
			expiresInSeconds: pairingLifetimeSeconds,
			error: "",
		}),
		exportRelayBundle: async () => ({
			path: "/Users/someone/relay",
			files: ["index.php", "INSTALL.txt"],
			installToken: "test-install-token",
			installedRelayHost,
			error: "",
		}),
		setChatShared: async () => ({}),
		removePairedDevice: async () => ({}),
		toggleRemoteControl: async () => ({}),
		setRelaySettings: async () => ({ error: "" }),
		revealRelayInstaller: async () => ({}),
	},
	FileServiceClient: {},
}))

const byTestId = (id: string) => screen.queryByTestId(id)

/** Opens the Remote Control popover. */
async function openPopover() {
	fireEvent.click(screen.getByTestId("remote-control-button"))
	await waitFor(() => expect(byTestId("remote-control-close")).not.toBeNull())
}

/** The Get installer button, which lives inside Relay settings; opens that section first when it is closed. */
function getInstallerButton(): HTMLElement {
	if (!byTestId("relay-export")) {
		fireEvent.click(screen.getByTestId("remote-control-relay-settings-toggle"))
	}
	return screen.getByTestId("relay-export")
}

/** Presses Pair a device and waits for the pairing popover. */
async function pair() {
	fireEvent.click(screen.getByTestId("remote-control-pair"))
	await waitFor(() => expect(byTestId("remote-control-pairing-popover")).not.toBeNull())
}

describe("Remote Control popover — pairing a device", () => {
	beforeEach(() => {
		pairedDevices = [{ id: "a1b2c3d4e5f60708", name: "iPhone", createdAt: 1, lastUsedAt: 1, lastSeenAt: 1 }]
		pairingLifetimeSeconds = 600
		extensionState.remoteControl.relayState = "connected"
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("opens the pairing code in its own popover, holding the code and the QR code", async () => {
		render(<RemoteControlToggle />)
		await openPopover()
		await pair()
		const pairing = byTestId("remote-control-pairing-popover") as HTMLElement
		expect(pairing.textContent).toContain("ABCD-EFGH")
		expect(pairing.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA")
		expect(byTestId("remote-control-pairing-close")).not.toBeNull()
	})

	it("closes the pairing popover with its ×, and leaves the Remote Control popover open", async () => {
		render(<RemoteControlToggle />)
		await openPopover()
		await pair()
		fireEvent.click(screen.getByTestId("remote-control-pairing-close"))
		await waitFor(() => expect(byTestId("remote-control-pairing-popover")).toBeNull())
		expect(byTestId("remote-control-close")).not.toBeNull()
	})

	it("closes the pairing popover on a click outside it, and leaves the Remote Control popover open", async () => {
		render(<RemoteControlToggle />)
		await openPopover()
		await pair()
		// A click inside the Remote Control popover is outside the pairing popover.
		fireEvent.mouseDown(screen.getByText(/^Paired devices/))
		fireEvent.click(screen.getByText(/^Paired devices/))
		await waitFor(() => expect(byTestId("remote-control-pairing-popover")).toBeNull())
		expect(byTestId("remote-control-close")).not.toBeNull()
	})

	it("closes the pairing popover on Escape, and leaves the Remote Control popover open", async () => {
		render(<RemoteControlToggle />)
		await openPopover()
		await pair()
		fireEvent.keyDown(document, { key: "Escape" })
		await waitFor(() => expect(byTestId("remote-control-pairing-popover")).toBeNull())
		expect(byTestId("remote-control-close")).not.toBeNull()
	})

	it("closes the pairing popover once a newly paired device appears", async () => {
		render(<RemoteControlToggle />)
		await openPopover()
		await pair()
		pairedDevices.push({ id: "0f1e2d3c4b5a6978", name: "Mac", createdAt: 2, lastUsedAt: 2 })
		await waitFor(() => expect(byTestId("remote-control-pairing-popover")).toBeNull(), { timeout: 5000 })
		expect(byTestId("remote-control-close")).not.toBeNull()
	})

	it("closes the pairing popover when the code's time runs out", async () => {
		pairingLifetimeSeconds = 1
		render(<RemoteControlToggle />)
		await openPopover()
		await pair()
		await waitFor(() => expect(byTestId("remote-control-pairing-popover")).toBeNull(), { timeout: 5000 })
		expect(byTestId("remote-control-close")).not.toBeNull()
	})
})

describe("Remote Control popover — the saved installer's steps", () => {
	beforeEach(() => {
		pairedDevices = []
		installedRelayHost = ""
	})

	it("with no relay installed at the Relay URL, shows the install steps only", async () => {
		render(<RemoteControlToggle />)
		await openPopover()
		fireEvent.click(getInstallerButton())
		await waitFor(() => expect(byTestId("relay-installer")).not.toBeNull())
		const steps = byTestId("relay-installer")?.textContent ?? ""
		expect(byTestId("relay-installer-update")).toBeNull()
		expect(steps).not.toContain("Installing on a new server:")
		expect(steps).toContain("1. Upload index.php to a folder on your web server.")
		expect((byTestId("relay-install-token") as HTMLInputElement).value).toBe("test-install-token")
	})

	it("with a relay installed at the Relay URL, shows how to update it, with the install steps closed until opened", async () => {
		installedRelayHost = "ivotelife.com"
		render(<RemoteControlToggle />)
		await openPopover()
		fireEvent.click(getInstallerButton())
		await waitFor(() => expect(byTestId("relay-installer")).not.toBeNull())
		expect(byTestId("relay-installer-update")?.textContent).toBe(
			"Updating the relay at ivotelife.com: upload index.php over the old one; nothing else; your relay key and paired devices stay",
		)
		const steps = byTestId("relay-installer")?.textContent ?? ""
		const update = steps.indexOf("Updating this relay")
		const newServer = steps.indexOf("Installing on a new server")
		expect(update >= 0 && update < newServer).toBe(true)
		expect(byTestId("relay-installer-install")).toBeNull()
		fireEvent.click(screen.getByTestId("relay-installer-install-toggle"))
		expect(byTestId("relay-installer-install")?.textContent).toContain("1. Upload index.php to a folder on your web server.")
		expect((byTestId("relay-install-token") as HTMLInputElement).value).toBe("test-install-token")
	})

	it("hides the installer steps once the relay is connected, and shows them after Get installer", async () => {
		extensionState.remoteControl.relayState = "failed"
		const view = render(<RemoteControlToggle />)
		await openPopover()
		fireEvent.click(getInstallerButton())
		await waitFor(() => expect(byTestId("relay-installer")).not.toBeNull())
		const shownWhileNotConnected = byTestId("relay-installer") !== null

		await act(async () => {
			extensionState.remoteControl.relayState = "connected"
			view.rerender(<RemoteControlToggle />)
		})
		const shownOnceConnected = byTestId("relay-installer") !== null

		fireEvent.click(getInstallerButton())
		await waitFor(() => expect(byTestId("relay-installer")).not.toBeNull())
		const shownAfterGetInstaller = byTestId("relay-installer") !== null

		expect({ shownWhileNotConnected, shownOnceConnected, shownAfterGetInstaller }).toEqual({
			shownWhileNotConnected: true,
			shownOnceConnected: false,
			shownAfterGetInstaller: true,
		})
	})
})
