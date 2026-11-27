import { describe, expect, it } from "vitest"
import { describeRelaySettings, maskRelayKey } from "./relaySettingsView"

describe("maskRelayKey", () => {
	it("shows nothing for an absent key", () => {
		expect(maskRelayKey("")).toBe("")
	})

	it("keeps only the tail, so a person can tell which key is in force", () => {
		expect(maskRelayKey("a".repeat(60) + "abcd")).toBe("••••abcd")
	})

	it("never returns the credential itself", () => {
		const key = "deadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcd"
		const masked = maskRelayKey(key)
		expect(masked.includes(key)).toBe(false)
		expect(masked.length).toBeLessThan(key.length)
	})
})

describe("describeRelaySettings", () => {
	it("reports presence and a masked tail, and carries no field holding the key", () => {
		const described = describeRelaySettings({ url: "https://example.com/relay", key: "x".repeat(64), pollIntervalMs: 1500 })
		expect(described.url).toBe("https://example.com/relay")
		expect(described.hasKey).toBe(true)
		expect(described.keyMasked).toBe("••••xxxx")
		expect(described.pollIntervalMs).toBe(1500)
		expect(described.error).toBe("")
		expect(Object.keys(described).some((field) => field.toLowerCase() === "key")).toBe(false)
	})

	it("says plainly when no relay has been configured yet", () => {
		const described = describeRelaySettings({ url: "", key: "", pollIntervalMs: 1500 })
		expect(described.hasKey).toBe(false)
		expect(described.keyMasked).toBe("")
		expect(described.url).toBe("")
	})
})
