import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import AlwaysRememberedFilesSection from "./AlwaysRememberedFilesSection"

const client = vi.hoisted(() => ({
	getAlwaysRememberedFiles: vi.fn(),
	addAlwaysRememberedFile: vi.fn(),
	pickAlwaysRememberedFile: vi.fn(),
	removeAlwaysRememberedFile: vi.fn(),
	moveAlwaysRememberedFile: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({ FileServiceClient: client }))

const row = (path: string, extra: Record<string, unknown> = {}) => ({
	path,
	resolvedPath: `/home/user/${path}`,
	status: "ok",
	chars: 4_000,
	estimatedTokens: 1_334,
	alreadyLoadedAsRule: false,
	...extra,
})

const state = (files: unknown[], extra: Record<string, unknown> = {}) => ({
	files,
	totalEstimatedTokens: 2_668,
	contextWindow: 262_144,
	endpointIsLocal: true,
	reachesCompactionTrigger: false,
	automaticWorkspaceLocations: [],
	automaticGlobalLocations: [],
	...extra,
})

beforeEach(() => {
	for (const fn of Object.values(client)) {
		fn.mockReset()
	}
	client.getAlwaysRememberedFiles.mockResolvedValue(state([row("a.md"), row("b.md")]))
})

describe("AlwaysRememberedFilesSection", () => {
	it("explains which locations are already remembered, even with an empty list", async () => {
		client.getAlwaysRememberedFiles.mockResolvedValue(
			state([], {
				automaticWorkspaceLocations: ["AGENTS.md", ".clinerules"],
				automaticGlobalLocations: ["~/.cline/rules", "~/Documents/Cline/Rules"],
			}),
		)
		render(<AlwaysRememberedFilesSection />)

		expect(await screen.findByText(/Already remembered automatically/)).toBeTruthy()
		expect(screen.getByText("This workspace")).toBeTruthy()
		expect(screen.getByText("All workspaces")).toBeTruthy()
		for (const location of ["AGENTS.md", ".clinerules", "~/.cline/rules", "~/Documents/Cline/Rules"]) {
			expect(screen.getByText(location)).toBeTruthy()
		}
		expect(screen.getByText(/directly inside the folder/)).toBeTruthy()
		expect(screen.getByText(/Other tools' files are not loaded automatically/)).toBeTruthy()
	})

	it("lists each file with its estimated tokens and the share of the saved window", async () => {
		render(<AlwaysRememberedFilesSection />)

		expect(await screen.findByText("a.md")).toBeTruthy()
		expect(screen.getByText("b.md")).toBeTruthy()
		expect(screen.getAllByText(/1,334 tokens/)).toHaveLength(2)
		expect(screen.getByText(/1\.0% of the 262,144-token context window/)).toBeTruthy()
	})

	it("adds a typed path on Enter and clears the box", async () => {
		client.addAlwaysRememberedFile.mockResolvedValue(state([row("a.md"), row("b.md"), row("c.md")]))
		render(<AlwaysRememberedFilesSection />)
		await screen.findByText("a.md")

		const box = screen.getByLabelText("File path to always remember") as HTMLInputElement
		fireEvent.change(box, { target: { value: "~/notes/work-contract.md" } })
		fireEvent.keyDown(box, { key: "Enter" })

		await screen.findByText("c.md")
		expect(client.addAlwaysRememberedFile.mock.calls[0][0].value).toBe("~/notes/work-contract.md")
		expect(box.value).toBe("")
	})

	it("shows an inline refusal and keeps the typed path", async () => {
		client.addAlwaysRememberedFile.mockResolvedValue(
			state([row("a.md"), row("b.md")], { addError: "File not found: ~/typo.md" }),
		)
		render(<AlwaysRememberedFilesSection />)
		await screen.findByText("a.md")

		const box = screen.getByLabelText("File path to always remember") as HTMLInputElement
		fireEvent.change(box, { target: { value: "~/typo.md" } })
		fireEvent.keyDown(box, { key: "Enter" })

		expect((await screen.findByRole("alert")).textContent).toContain("File not found")
		expect(box.value).toBe("~/typo.md")
	})

	it("adds through the file picker", async () => {
		client.pickAlwaysRememberedFile.mockResolvedValue(state([row("a.md"), row("b.md"), row("picked.md")]))
		render(<AlwaysRememberedFilesSection />)
		await screen.findByText("a.md")

		fireEvent.click(screen.getByRole("button", { name: "Add File" }))

		expect(await screen.findByText("picked.md")).toBeTruthy()
	})

	it("shows the Enter hint only while the box holds text", async () => {
		render(<AlwaysRememberedFilesSection />)
		await screen.findByText("a.md")
		const box = screen.getByLabelText("File path to always remember")

		expect(screen.queryByText("Enter")).toBeNull()

		fireEvent.change(box, { target: { value: "   " } })
		expect(screen.queryByText("Enter")).toBeNull()

		fireEvent.change(box, { target: { value: "~/notes/work-contract.md" } })
		expect(screen.getByRole("button", { name: "Add this path" }).textContent).toBe("Enter")

		fireEvent.change(box, { target: { value: "" } })
		expect(screen.queryByText("Enter")).toBeNull()
	})

	it("adds a typed path when the Enter hint is tapped, without opening the picker", async () => {
		client.addAlwaysRememberedFile.mockResolvedValue(state([row("a.md"), row("b.md"), row("c.md")]))
		render(<AlwaysRememberedFilesSection />)
		await screen.findByText("a.md")

		const box = screen.getByLabelText("File path to always remember") as HTMLInputElement
		fireEvent.change(box, { target: { value: "~/notes/work-contract.md" } })
		fireEvent.click(screen.getByText("Enter"))

		await screen.findByText("c.md")
		expect(client.addAlwaysRememberedFile).toHaveBeenCalledTimes(1)
		expect(client.addAlwaysRememberedFile.mock.calls[0][0].value).toBe("~/notes/work-contract.md")
		expect(client.pickAlwaysRememberedFile).not.toHaveBeenCalled()
		expect(box.value).toBe("")
	})

	it("adds a typed path from the Add File button without opening the picker", async () => {
		client.addAlwaysRememberedFile.mockResolvedValue(state([row("a.md"), row("b.md"), row("c.md")]))
		render(<AlwaysRememberedFilesSection />)
		await screen.findByText("a.md")

		const box = screen.getByLabelText("File path to always remember") as HTMLInputElement
		fireEvent.change(box, { target: { value: "  ~/notes/work-contract.md  " } })
		fireEvent.click(screen.getByRole("button", { name: "Add File" }))

		await screen.findByText("c.md")
		expect(client.addAlwaysRememberedFile.mock.calls[0][0].value).toBe("~/notes/work-contract.md")
		expect(client.pickAlwaysRememberedFile).not.toHaveBeenCalled()
		expect(box.value).toBe("")
	})

	it("opens the picker and adds nothing when the box is blank", async () => {
		client.pickAlwaysRememberedFile.mockResolvedValue(state([row("a.md"), row("b.md")]))
		render(<AlwaysRememberedFilesSection />)
		await screen.findByText("a.md")

		fireEvent.change(screen.getByLabelText("File path to always remember"), { target: { value: "   " } })
		fireEvent.click(screen.getByRole("button", { name: "Add File" }))

		await waitFor(() => expect(client.pickAlwaysRememberedFile).toHaveBeenCalledTimes(1))
		expect(client.addAlwaysRememberedFile).not.toHaveBeenCalled()
	})

	it("keeps the text and shows the error when the button's path is refused", async () => {
		client.addAlwaysRememberedFile.mockResolvedValue(
			state([row("a.md"), row("b.md")], { addError: "File not found: ~/typo.md" }),
		)
		render(<AlwaysRememberedFilesSection />)
		await screen.findByText("a.md")

		const box = screen.getByLabelText("File path to always remember") as HTMLInputElement
		fireEvent.change(box, { target: { value: "~/typo.md" } })
		fireEvent.click(screen.getByRole("button", { name: "Add File" }))

		expect((await screen.findByRole("alert")).textContent).toContain("File not found")
		expect(box.value).toBe("~/typo.md")
		expect(client.pickAlwaysRememberedFile).not.toHaveBeenCalled()
	})

	it("removes a row with one click", async () => {
		client.removeAlwaysRememberedFile.mockResolvedValue(state([row("b.md")]))
		render(<AlwaysRememberedFilesSection />)
		await screen.findByText("a.md")

		fireEvent.click(screen.getByRole("button", { name: "Remove a.md" }))

		await waitFor(() => expect(screen.queryByText("a.md")).toBeNull())
		expect(client.removeAlwaysRememberedFile.mock.calls[0][0].value).toBe("a.md")
	})

	it("reorders with the arrows and disables them at the ends", async () => {
		client.moveAlwaysRememberedFile.mockResolvedValue(state([row("b.md"), row("a.md")]))
		render(<AlwaysRememberedFilesSection />)
		await screen.findByText("a.md")

		expect((screen.getByRole("button", { name: "Move a.md up" }) as HTMLButtonElement).disabled).toBe(true)
		expect((screen.getByRole("button", { name: "Move b.md down" }) as HTMLButtonElement).disabled).toBe(true)

		fireEvent.click(screen.getByRole("button", { name: "Move a.md down" }))

		await waitFor(() => expect(client.moveAlwaysRememberedFile).toHaveBeenCalledTimes(1))
		expect(client.moveAlwaysRememberedFile.mock.calls[0][0]).toMatchObject({ path: "a.md", delta: 1 })
	})

	it("shows a failed file as an error with a working remove button", async () => {
		client.getAlwaysRememberedFiles.mockResolvedValue(
			state([row("gone.md", { status: "missing", error: "file not found", chars: 0, estimatedTokens: 0 })]),
		)
		render(<AlwaysRememberedFilesSection />)

		expect((await screen.findByText(/file not found/)).textContent).toContain("file not found")
		expect(screen.getByRole("button", { name: "Remove gone.md" })).toBeTruthy()
	})

	it("warns on a remote endpoint and when the files reach the compaction trigger", async () => {
		client.getAlwaysRememberedFiles.mockResolvedValue(
			state([row("a.md")], { endpointIsLocal: false, reachesCompactionTrigger: true }),
		)
		render(<AlwaysRememberedFilesSection />)

		expect(await screen.findByText(/sent to a remote model endpoint/)).toBeTruthy()
		expect(screen.getByText(/alone reach the compaction trigger/)).toBeTruthy()
	})
})
