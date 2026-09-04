import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	attachBridgeSubmissionToSession,
	beginBridgeSubmission,
	currentBridgeSubmission,
	getBridgeDebugRuns,
	recordBridgeDebug,
} from "./bridgeDebug"

vi.mock("@/shared/services/Logger", () => ({
	Logger: { log: vi.fn(), error: vi.fn() },
}))

/**
 * Cline Cubed — bridge debug lines belong to the run that produced them, and a run stays reachable
 * after later runs begin.
 *
 * The panel that shows these lines is attached to ONE message, so two properties have to hold at
 * once and they pull in opposite directions. Lines must never cross runs, because a line that is a
 * true statement about one message reads, under another, as a claim about that one. And a run must
 * outlive the runs that follow it, because a run begins on every send, so a message has to keep
 * finding its own calls once the conversation has moved on.
 *
 * These tests pin both.
 */
describe("bridge debug submissions", () => {
	/**
	 * Module state is shared across this file, so every assertion selects the run it started rather
	 * than assuming which runs exist.
	 */
	const runFor = (submission: number) => getBridgeDebugRuns().find((run) => run.submission === submission)

	beforeEach(() => {
		beginBridgeSubmission()
	})

	it("keeps each run's lines with that run, never merged into one window", () => {
		recordBridgeDebug("skipped: no images", false, false)
		const first = currentBridgeSubmission()

		beginBridgeSubmission()
		recordBridgeDebug("skipped: no images", false, false)
		const second = currentBridgeSubmission()

		beginBridgeSubmission()
		recordBridgeDebug("deepseek vision -> https://api.example/x (image image/png, status 200)", false, false)
		const third = currentBridgeSubmission()

		expect(runFor(third)?.lines).toHaveLength(1)
		expect(runFor(third)?.lines[0].line).toContain("status 200")
		// The property that matters most here: earlier messages' skips must not ride along.
		expect(runFor(third)?.lines.some((l) => l.line.includes("no images"))).toBe(false)
		expect(runFor(first)?.lines[0].line).toContain("no images")
		expect(runFor(second)?.lines[0].line).toContain("no images")
	})

	it("keeps an EARLIER run retrievable after a later run has begun", () => {
		// The message that owns this run keeps showing its own calls after further messages are sent.
		recordBridgeDebug("deepseek vision -> https://api.example/x (image image/png, status 200)", false, false)
		const mine = currentBridgeSubmission()

		beginBridgeSubmission()
		recordBridgeDebug("skipped: no images", false, false)

		const earlier = runFor(mine)
		expect(earlier).toBeDefined()
		expect(earlier?.lines).toHaveLength(1)
		expect(earlier?.lines[0].line).toContain("status 200")
	})

	it("returns runs oldest first, so the newest is last", () => {
		recordBridgeDebug("older", false, false)
		const older = currentBridgeSubmission()
		beginBridgeSubmission()
		recordBridgeDebug("newer", false, false)
		const newer = currentBridgeSubmission()

		const runs = getBridgeDebugRuns()
		expect(runs.findIndex((r) => r.submission === older)).toBeLessThan(runs.findIndex((r) => r.submission === newer))
	})

	it("keeps every line of one run, in order, with its time", () => {
		recordBridgeDebug("first", false, false)
		recordBridgeDebug("second", false, false)
		const run = runFor(currentBridgeSubmission())
		expect(run?.lines.map((l) => l.line)).toEqual(["first", "second"])
		for (const line of run?.lines ?? []) {
			expect(typeof line.ts).toBe("number")
			expect(line.ts).toBeGreaterThan(0)
		}
	})

	it("stamps when the run began, so a message can tell whether it caused it", () => {
		const before = Date.now()
		beginBridgeSubmission()
		recordBridgeDebug("a call", false, false)
		const run = runFor(currentBridgeSubmission())
		expect(run?.startedAt).toBeGreaterThanOrEqual(before)
		expect(run?.startedAt).toBeLessThanOrEqual(Date.now())
	})

	it("carries the chat a run belongs to, so another chat's panel can rule itself out", () => {
		beginBridgeSubmission("session-A")
		recordBridgeDebug("a call in A", false, false)
		expect(runFor(currentBridgeSubmission())?.sessionId).toBe("session-A")
	})

	it("keeps another chat's run separate rather than offering it as this chat's", () => {
		beginBridgeSubmission("session-A")
		recordBridgeDebug("a call in A", false, false)
		const inA = currentBridgeSubmission()

		beginBridgeSubmission("session-B")
		recordBridgeDebug("a call in B", false, false)
		const inB = currentBridgeSubmission()

		// Both survive, each labelled — the panel decides which is its own by session id.
		expect(runFor(inA)?.sessionId).toBe("session-A")
		expect(runFor(inB)?.sessionId).toBe("session-B")
		expect(runFor(inA)?.lines[0].line).toContain("in A")
		expect(runFor(inB)?.lines[0].line).toContain("in B")
	})

	it("lets the new-chat path name its own run once the chat exists", () => {
		// Starting a NEW chat bridges BEFORE the session id exists, so the run is claimed after.
		beginBridgeSubmission()
		recordBridgeDebug("a call with no chat yet", false, false)
		const mine = currentBridgeSubmission()
		attachBridgeSubmissionToSession("session-new", mine)
		expect(runFor(mine)?.sessionId).toBe("session-new")
	})

	it("ignores a stale claim from a run that has already been superseded", () => {
		beginBridgeSubmission()
		const earlier = currentBridgeSubmission()
		beginBridgeSubmission("session-B")
		recordBridgeDebug("a call in B", false, false)
		// The earlier submission's chat is created late and tries to claim the run in flight.
		attachBridgeSubmissionToSession("session-stale", earlier)
		expect(runFor(currentBridgeSubmission())?.sessionId).toBe("session-B")
	})

	it("reports whether the run's last call failed", () => {
		recordBridgeDebug("ok", false, false)
		expect(runFor(currentBridgeSubmission())?.lastFailed).toBe(false)
		recordBridgeDebug("boom", true, false)
		expect(runFor(currentBridgeSubmission())?.lastFailed).toBe(true)
	})

	it("omits a run that recorded nothing, rather than giving it another run's lines", () => {
		recordBridgeDebug("from the earlier run", false, false)
		const withLines = currentBridgeSubmission()

		beginBridgeSubmission()
		const empty = currentBridgeSubmission()

		expect(runFor(empty)).toBeUndefined()
		// And the run that did record something is untouched by the empty one that followed.
		expect(runFor(withLines)?.lines.map((l) => l.line)).toEqual(["from the earlier run"])
	})
})
