import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RemoteConfigToggle } from "@/components/account/RemoteConfigToggle"
import McpToolRow, { SHOW_MCP_PER_TOOL_AUTO_APPROVE } from "@/components/mcp/configuration/tabs/installed/server-row/McpToolRow"

const mocks = vi.hoisted(() => ({
	onChange: undefined as undefined | ((event: unknown) => unknown),
	toggleToolAutoApprove: vi.fn(async () => ({ mcpServers: [] })),
	updateSettings: vi.fn(async () => undefined),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, onChange }: { children?: ReactNode; onChange?: (event: unknown) => unknown }) => {
		mocks.onChange = onChange
		return <button type="button">{children}</button>
	},
}))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		optOutOfRemoteConfig: true,
		remoteConfigAvailable: true,
		autoApprovalSettings: { actions: { useMcp: true } },
		setMcpServers: vi.fn(),
	}),
}))
vi.mock("@/components/account/helpers", () => ({ isAdminOrOwner: () => true }))
vi.mock("@/services/grpc-client", () => ({
	McpServiceClient: { toggleToolAutoApprove: mocks.toggleToolAutoApprove },
	StateServiceClient: { updateSettings: mocks.updateSettings },
}))
vi.mock("@shared/proto-conversions/mcp/mcp-server-conversion", () => ({ convertProtoMcpServersToMcpServers: () => [] }))

const change = (checked: boolean) => mocks.onChange?.({ target: { checked } })

describe("checkboxes that save through the host", () => {
	beforeEach(() => {
		mocks.toggleToolAutoApprove.mockClear()
		mocks.updateSettings.mockClear()
	})

	it("the remote-config opt-out ignores a redraw", () => {
		render(<RemoteConfigToggle activeOrganization={{} as never} />)

		change(true)

		expect(mocks.updateSettings).not.toHaveBeenCalled()
	})

	it("the remote-config opt-out saves a click once", () => {
		render(<RemoteConfigToggle activeOrganization={{} as never} />)

		fireEvent.click(screen.getByRole("button"))
		change(false)
		change(false)

		expect(mocks.updateSettings).toHaveBeenCalledTimes(1)
		expect(mocks.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ optOutOfRemoteConfig: false }))
	})

	// These boxes are hidden while the flag is off; the suite runs whenever it is on.
	describe.skipIf(!SHOW_MCP_PER_TOOL_AUTO_APPROVE)("MCP auto-approve", () => {
		const tool = { name: "tool-a", autoApprove: true } as never

		it("a redraw cannot turn auto-approve back on", () => {
			render(<McpToolRow serverName="server" tool={tool} />)

			change(true)

			expect(mocks.toggleToolAutoApprove).not.toHaveBeenCalled()
		})

		it("saves the value clicked, once", async () => {
			render(<McpToolRow serverName="server" tool={tool} />)

			fireEvent.click(screen.getByRole("button", { name: "Auto-approve" }))
			change(false)
			change(true)

			await waitFor(() => expect(mocks.toggleToolAutoApprove).toHaveBeenCalledTimes(1))
			expect(mocks.toggleToolAutoApprove).toHaveBeenCalledWith(expect.objectContaining({ autoApprove: false }))
		})
	})
})
