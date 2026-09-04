import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ClineFileStorage } from "./ClineFileStorage"

/**
 * Cline Cubed — one instance's write must not erase another instance's keys.
 *
 * Every process using a storage file has its own instance, and each holds the file's contents in
 * memory. Serialising that whole object back on every write restores a picture of the file taken
 * when the instance was constructed, which deletes anything changed since. In practice that is one
 * VS Code window undoing settings saved in another, and the reported shape of it is a reinstall
 * appearing to reset a setting to its default.
 *
 * These tests pin the property that prevents it: a write may only change the keys it names.
 */
describe("ClineFileStorage", () => {
	let dir: string
	let file: string

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-file-storage-"))
		file = path.join(dir, "globalState.json")
	})

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true })
	})

	const onDisk = (): Record<string, unknown> => JSON.parse(fs.readFileSync(file, "utf-8"))

	it("does not erase a key another instance wrote after this one was constructed", () => {
		fs.writeFileSync(file, JSON.stringify({ newChatLocation: "secondarySidebar" }))

		// Two live instances over one file — the shape of two VS Code windows.
		const windowA = new ClineFileStorage(file, "A")
		const windowB = new ClineFileStorage(file, "B")

		// The person changes two settings in window B.
		windowB.setBatch({ newChatLocation: "editor", debugLoggingEnabled: true })

		// Window A, whose snapshot predates both, writes something ordinary of its own — a version
		// stamp, a distinct id, anything at all.
		windowA.set("clineVersion", "4.1.23")

		const after = onDisk()
		expect(after.newChatLocation).toBe("editor")
		expect(after.debugLoggingEnabled).toBe(true)
		expect(after.clineVersion).toBe("4.1.23")
	})

	it("does not resurrect a key another instance deleted", () => {
		fs.writeFileSync(file, JSON.stringify({ staleKey: "gone soon", other: 1 }))
		const windowA = new ClineFileStorage(file, "A")
		const windowB = new ClineFileStorage(file, "B")

		windowB.delete("staleKey")
		windowA.set("other", 2)

		const after = onDisk()
		expect("staleKey" in after).toBe(false)
		expect(after.other).toBe(2)
	})

	it("still does the ordinary things: read back, batch, delete", () => {
		const store = new ClineFileStorage(file, "Store")

		store.set("a", 1)
		store.setBatch({ b: 2, c: 3 })
		expect(store.get("a")).toBe(1)
		expect(store.get("b")).toBe(2)
		expect(store.get("c")).toBe(3)
		expect(onDisk()).toEqual({ a: 1, b: 2, c: 3 })

		store.delete("b")
		expect(store.get("b")).toBeUndefined()
		expect("b" in onDisk()).toBe(false)

		// A defaulted read still answers for a key that is not there.
		expect(store.get("missing", "fallback")).toBe("fallback")
	})

	it("picks up the file's other keys into its own view when it writes", () => {
		fs.writeFileSync(file, JSON.stringify({ existing: "value" }))
		const windowA = new ClineFileStorage(file, "A")
		const windowB = new ClineFileStorage(file, "B")

		windowB.set("addedByB", "b-value")
		// A has never heard of addedByB; writing merges the current file into its view.
		windowA.set("addedByA", "a-value")

		expect(windowA.get("addedByB")).toBe("b-value")
		expect(onDisk()).toEqual({ existing: "value", addedByB: "b-value", addedByA: "a-value" })
	})
})
