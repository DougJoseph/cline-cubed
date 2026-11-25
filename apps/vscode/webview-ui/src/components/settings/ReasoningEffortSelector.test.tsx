import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ReasoningEffortSelector from "./ReasoningEffortSelector"

const mocks = vi.hoisted(() => ({ apiConfiguration: {} as Record<string, unknown> }))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ apiConfiguration: mocks.apiConfiguration }),
}))
vi.mock("./utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({ handleModeFieldChange: vi.fn() }),
}))
vi.mock("@/components/ui/select", () => ({
	Select: ({ children, value }: { children?: ReactNode; value?: string }) => (
		<div data-testid="select" data-value={value ?? ""}>
			{children}
		</div>
	),
	SelectContent: () => null,
	SelectItem: () => null,
	SelectTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
}))

const shown = () => screen.getByTestId("select").getAttribute("data-value")

describe("ReasoningEffortSelector", () => {
	beforeEach(() => {
		mocks.apiConfiguration = {}
	})

	it("shows Model default, not an invented effort, when the mode has none stored", () => {
		render(<ReasoningEffortSelector currentMode="plan" defaultEffort="medium" />)

		expect(shown()).toBe("")
		expect(screen.getByText("Model default")).toBeInTheDocument()
	})

	it("shows the mode's own stored effort", () => {
		mocks.apiConfiguration = { planModeReasoningEffort: "xhigh", actModeReasoningEffort: "low" }
		render(<ReasoningEffortSelector currentMode="plan" />)

		expect(shown()).toBe("xhigh")
	})

	it("shows the effort a stored thinking budget maps to", () => {
		mocks.apiConfiguration = { actModeThinkingBudgetTokens: 6000 }
		render(<ReasoningEffortSelector currentMode="act" />)

		expect(shown()).toBe("medium")
	})
})
