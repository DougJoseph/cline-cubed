import { beforeEach, describe, expect, it } from "vitest"
import { Logger } from "./Logger"

/**
 * Cline Cubed — the master debug-logging switch, and the redaction that is NOT subject to it.
 *
 * Two separate promises are pinned here, because they fail in opposite directions:
 *   - the switch decides whether diagnostic lines are emitted at all, while errors and warnings
 *     are emitted whatever it says (gating a real failure is how a live problem leaves no trace);
 *   - redaction applies to every line that is emitted, on or off, because turning the volume down
 *     is not the same as it being acceptable to print credential material.
 */
describe("Logger", () => {
	let seen: string[]

	beforeEach(() => {
		seen = []
		Logger.subscribe((msg) => seen.push(msg))
		Logger.setDebugEnabled(false)
	})

	describe("the master debug switch", () => {
		it("emits nothing at debug/log/info/trace while OFF", () => {
			Logger.debug("a debug line")
			Logger.log("a log line")
			Logger.info("an info line")
			Logger.trace("a trace line")
			expect(seen).toEqual([])
		})

		it("still emits errors and warnings while OFF", () => {
			Logger.error("something broke")
			Logger.warn("something is odd")
			expect(seen.some((l) => l.includes("ERROR something broke"))).toBe(true)
			expect(seen.some((l) => l.includes("WARN something is odd"))).toBe(true)
		})

		it("emits the diagnostic levels once turned ON", () => {
			Logger.setDebugEnabled(true)
			Logger.debug("a debug line")
			Logger.log("a log line")
			expect(seen.some((l) => l.includes("DEBUG a debug line"))).toBe(true)
			expect(seen.some((l) => l.includes("LOG a log line"))).toBe(true)
		})

		it("reports its own state", () => {
			expect(Logger.isDebugEnabled()).toBe(false)
			Logger.setDebugEnabled(true)
			expect(Logger.isDebugEnabled()).toBe(true)
		})
	})

	describe("redaction at the sink", () => {
		beforeEach(() => Logger.setDebugEnabled(true))

		it("redacts EVERY key name ending in Hash, not a listed few", () => {
			// The same two credentials print under eleven spellings across this codebase; these are
			// three of them. Pinned by shape rather than by name, so a new spelling is covered.
			Logger.debug("[SdkAuthService] writeClineCredentials: wrote (accessHash=42ef7a53, refreshHash=d4e48756)")
			Logger.debug("[SdkAuthService] fetchUserInfoFromApi: GET https://api.cline.bot/x (tokenHash=42ef7a53)")
			Logger.debug("cline.refresh.success newAccessTokenHash=aaaa1111 newRefreshTokenHash=bbbb2222")
			const line = seen.join("\n")
			for (const value of ["42ef7a53", "d4e48756", "aaaa1111", "bbbb2222"]) {
				expect(line).not.toContain(value)
			}
			expect(line).toContain("accessHash=<redacted>")
			expect(line).toContain("tokenHash=<redacted>")
			expect(line).toContain("newRefreshTokenHash=<redacted>")
			// What it was doing stays readable — only the value is taken.
			expect(line).toContain("https://api.cline.bot/x")
		})

		it("takes the value and nothing else — brackets and punctuation survive", () => {
			// Values are commonly bracketed: `(tokenHash=abc123)`, `keys=[apiKey=x]`. A redaction
			// that eats the closing bracket leaves a line reading as truncated, which is worse than
			// useless in a diagnostic log.
			Logger.debug("fetchUserInfoFromApi: GET https://api.cline.bot/x (tokenHash=42ef7a53)")
			Logger.debug("keys=[apiKey=not-a-real-key] done")
			const line = seen.join("\n")
			expect(line).toContain("(tokenHash=<redacted>)")
			expect(line).toContain("keys=[apiKey=<redacted>] done")
		})

		it("redacts the person's identity from the identify payload", () => {
			Logger.debug('identifyUser - {"email":"someone@example.com","displayName":"Some One","organizations":[]}')
			const line = seen.join("\n")
			expect(line).not.toContain("someone@example.com")
			expect(line).not.toContain("Some One")
			expect(line).toContain('"email":"<redacted>"')
			expect(line).toContain('"displayName":"<redacted>"')
			expect(line).toContain('"organizations":[]')
		})

		it("redacts the SDK's provider-read line while keeping it readable", () => {
			// The real shape, from sdk/.../provider-settings-manager.ts — a line this fork does
			// not own, which reaches the channel through setSdkLogger.
			Logger.debug(
				"providers.read providers=[cline,deepseek] lastUsed=cline clineAuthPresent=true " +
					"clineAccessTokenHash=6a770ac3 clineRefreshTokenHash=d2824b39",
			)
			const line = seen.join("\n")
			expect(line).not.toContain("6a770ac3")
			expect(line).not.toContain("d2824b39")
			// The KEY stays visible: a redacted line is evidence, a deleted one is a mystery.
			expect(line).toContain("clineAccessTokenHash=<redacted>")
			expect(line).toContain("clineRefreshTokenHash=<redacted>")
			// Everything non-sensitive survives.
			expect(line).toContain("providers=[cline,deepseek]")
			expect(line).toContain("lastUsed=cline")
		})

		it("redacts JSON-shaped values, as telemetry payloads carry them", () => {
			Logger.log('ui.prompt_submitted: {"device_id":"0ae16625db2c","platform":"Visual Studio Code"}')
			const line = seen.join("\n")
			expect(line).not.toContain("0ae16625db2c")
			expect(line).toContain('"device_id":"<redacted>"')
			expect(line).toContain('"platform":"Visual Studio Code"')
		})

		it("redacts an ERROR too — the switch does not govern this", () => {
			Logger.setDebugEnabled(false)
			Logger.error("auth failed apiKey=not-a-real-key while refreshing")
			const line = seen.join("\n")
			expect(line).not.toContain("not-a-real-key")
			expect(line).toContain("apiKey=<redacted>")
			expect(line).toContain("while refreshing")
		})
	})
})
