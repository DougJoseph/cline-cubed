import { afterEach, describe, expect, it, vi } from "vitest"
import {
	beginSettingsLoad,
	clearModelListSlow,
	endSettingsLoad,
	getSettingsHealth,
	NoAnswerError,
	reportModelListSlow,
	reportSettingsLoadFailure,
	reportSettingsSaveFailure,
	resetSettingsHealth,
	retrySettingsLoad,
	withAnswerLimit,
} from "./settingsHealth"

afterEach(() => {
	vi.useRealTimers()
	resetSettingsHealth()
})

describe("withAnswerLimit", () => {
	it("passes an answer through", async () => {
		await expect(withAnswerLimit(Promise.resolve("ok"), 1_000)).resolves.toBe("ok")
	})

	it("passes a failure through", async () => {
		await expect(withAnswerLimit(Promise.reject(new Error("boom")), 1_000)).rejects.toThrow("boom")
	})

	it("fails when no answer arrives within the limit", async () => {
		vi.useFakeTimers()
		const result = withAnswerLimit(new Promise(() => undefined), 1_000)
		const assertion = expect(result).rejects.toBeInstanceOf(NoAnswerError)

		await vi.advanceTimersByTimeAsync(1_000)

		await assertion
	})
})

describe("settings health", () => {
	it("records a failed load until Retry", () => {
		reportSettingsLoadFailure()
		expect(getSettingsHealth().loadFailed).toBe(true)

		retrySettingsLoad()

		expect(getSettingsHealth()).toMatchObject({ loadFailed: false, retryCount: 1 })
	})

	it("lists each failed save once", () => {
		reportSettingsSaveFailure("API key")
		reportSettingsSaveFailure("API key")
		reportSettingsSaveFailure("Base URL")

		expect(getSettingsHealth().saveFailures).toEqual(["API key", "Base URL"])
	})

	it("Retry also clears save and model-list failures", () => {
		reportSettingsSaveFailure("model")
		reportModelListSlow("request-1")

		retrySettingsLoad()

		expect(getSettingsHealth()).toMatchObject({ saveFailures: [], slowModelLists: [] })
	})

	it("counts settings loads in progress", () => {
		beginSettingsLoad()
		beginSettingsLoad()
		endSettingsLoad()
		expect(getSettingsHealth().loadsInProgress).toBe(1)

		endSettingsLoad()

		expect(getSettingsHealth().loadsInProgress).toBe(0)
	})

	it("a late model-list answer removes only its own slow notice", () => {
		reportModelListSlow("request-1")
		reportModelListSlow("request-2")

		clearModelListSlow("request-1")

		expect(getSettingsHealth().slowModelLists).toEqual(["request-2"])
	})
})
