import { describe, expect, it, vi } from "vitest"
import {
	applyProviderConnectionChange,
	type ConnectionWritePatch,
	connectionChangesFromWrite,
} from "./provider-connection-update"

describe("connectionChangesFromWrite", () => {
	it("takes the stored value of each connection field the write changed", () => {
		expect(
			connectionChangesFromWrite(
				{ baseUrl: "http://new/v1" },
				{ baseUrl: "http://new/v1", apiKey: "key", headers: { a: "b" } },
			),
		).toEqual({ baseUrl: "http://new/v1" })
		expect(connectionChangesFromWrite({ apiKey: "k2" }, { apiKey: "k2" })).toEqual({ apiKey: "k2" })
		expect(connectionChangesFromWrite({ headers: { x: "1" } }, { headers: { x: "1" } })).toEqual({ headers: { x: "1" } })
		expect(connectionChangesFromWrite({ clearHeaders: true }, {})).toEqual({ headers: {} })
	})

	it("reports no change for a write that touches no connection field", () => {
		// A write of another field, such as a Bedrock region, carries none of these.
		const regionOnly = { region: "us-east-1" } as unknown as ConnectionWritePatch
		expect(connectionChangesFromWrite(regionOnly, {})).toBeUndefined()
		expect(connectionChangesFromWrite({ headers: {} }, {})).toBeUndefined()
	})
})

describe("applyProviderConnectionChange", () => {
	const session = (sessionId: string, providerId: string | undefined) => ({
		sessionId,
		providerId,
		update: vi.fn(async () => undefined),
	})

	it("updates every open session on that provider with only the changed fields, and none on another", async () => {
		const first = session("s1", "openai")
		const second = session("s2", "openai-compatible")
		const other = session("s3", "anthropic")
		const report = vi.fn()

		const updated = await applyProviderConnectionChange(
			[first, second, other],
			"openai",
			{ baseUrl: "http://new/v1" },
			report,
		)

		expect(first.update).toHaveBeenCalledWith({ baseUrl: "http://new/v1" })
		expect(second.update).toHaveBeenCalledWith({ baseUrl: "http://new/v1" })
		expect(other.update).not.toHaveBeenCalled()
		expect(updated).toEqual(["s1", "s2"])
		expect(report).not.toHaveBeenCalled()
	})

	it("reports a failed update in that chat and still updates the rest", async () => {
		const failing = session("s1", "openai")
		failing.update.mockRejectedValueOnce(new Error("boom"))
		const fine = session("s2", "openai")
		const report = vi.fn()

		const updated = await applyProviderConnectionChange([failing, fine], "openai", { apiKey: "k" }, report)

		expect(report).toHaveBeenCalledWith("s1", expect.any(Error))
		expect(fine.update).toHaveBeenCalledWith({ apiKey: "k" })
		expect(updated).toEqual(["s2"])
	})
})
