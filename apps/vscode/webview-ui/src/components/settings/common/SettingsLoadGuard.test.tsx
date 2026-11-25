import { act, fireEvent, render, screen } from "@testing-library/react"
import { type ReactNode, useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	beginSettingsLoad,
	clearModelListSlow,
	endSettingsLoad,
	reportModelListSlow,
	reportSettingsLoadFailure,
	reportSettingsSaveFailure,
	resetSettingsHealth,
} from "@/utils/settingsHealth"
import { SettingsLoadGuard } from "./SettingsLoadGuard"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
		<button onClick={onClick} type="button">
			{children}
		</button>
	),
}))

afterEach(() => act(() => resetSettingsHealth()))

const Fields = ({ onMount }: { onMount?: () => void }) => {
	useEffect(() => onMount?.(), [onMount])
	return <input aria-label="API key" />
}

describe("SettingsLoadGuard", () => {
	it("shows the fields during a normal load", () => {
		render(
			<SettingsLoadGuard>
				<Fields />
			</SettingsLoadGuard>,
		)

		expect(screen.getByLabelText("API key")).toBeInTheDocument()
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
	})

	it("replaces the fields with a message after a failed load", () => {
		render(
			<SettingsLoadGuard>
				<Fields />
			</SettingsLoadGuard>,
		)

		act(() => reportSettingsLoadFailure())

		expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load your settings. Nothing has been changed.")
		expect(screen.queryByLabelText("API key")).not.toBeInTheDocument()
	})

	it("Retry brings the fields back and loads them again", () => {
		const onMount = vi.fn()
		render(
			<SettingsLoadGuard>
				<Fields onMount={onMount} />
			</SettingsLoadGuard>,
		)
		act(() => reportSettingsLoadFailure())

		fireEvent.click(screen.getByRole("button", { name: "Retry" }))

		expect(screen.getByLabelText("API key")).toBeInTheDocument()
		expect(onMount).toHaveBeenCalledTimes(2)
	})

	it("suggests reloading the window when Retry also fails", () => {
		render(
			<SettingsLoadGuard>
				<Fields />
			</SettingsLoadGuard>,
		)
		act(() => reportSettingsLoadFailure())
		fireEvent.click(screen.getByRole("button", { name: "Retry" }))

		act(() => reportSettingsLoadFailure())

		expect(screen.getByRole("alert")).toHaveTextContent("Developer: Reload Window")
	})

	it("names a failed save and keeps the fields", () => {
		render(
			<SettingsLoadGuard>
				<Fields />
			</SettingsLoadGuard>,
		)

		act(() => reportSettingsSaveFailure("API key"))

		expect(screen.getByRole("alert")).toHaveTextContent("Couldn't save API key.")
		expect(screen.getByLabelText("API key")).toBeInTheDocument()
	})

	it("says when the model list is slow, keeps the fields, and clears on a late answer", () => {
		render(
			<SettingsLoadGuard>
				<Fields />
			</SettingsLoadGuard>,
		)

		act(() => reportModelListSlow("request-1"))
		expect(screen.getByRole("alert")).toHaveTextContent("The model list is taking longer than expected.")
		expect(screen.getByLabelText("API key")).toBeInTheDocument()

		act(() => clearModelListSlow("request-1"))
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
	})

	describe("while settings are loading", () => {
		beforeEach(() => vi.useFakeTimers())
		afterEach(() => vi.useRealTimers())

		it("shows nothing extra for a load under 250 ms", () => {
			render(
				<SettingsLoadGuard>
					<Fields />
				</SettingsLoadGuard>,
			)
			act(() => beginSettingsLoad())
			act(() => vi.advanceTimersByTime(249))
			act(() => endSettingsLoad())
			act(() => vi.advanceTimersByTime(10))

			expect(screen.queryByText("Loading your settings…")).not.toBeInTheDocument()
			expect(screen.getByLabelText("API key")).toBeVisible()
		})

		it("replaces the fields with a loading message at 250 ms, without remounting them", () => {
			const onMount = vi.fn()
			render(
				<SettingsLoadGuard>
					<Fields onMount={onMount} />
				</SettingsLoadGuard>,
			)
			act(() => beginSettingsLoad())
			act(() => vi.advanceTimersByTime(250))

			expect(screen.getByRole("status")).toHaveTextContent("Loading your settings…")
			expect(screen.getByLabelText("API key")).not.toBeVisible()

			act(() => endSettingsLoad())

			expect(screen.queryByRole("status")).not.toBeInTheDocument()
			expect(screen.getByLabelText("API key")).toBeVisible()
			expect(onMount).toHaveBeenCalledTimes(1)
		})
	})
})
