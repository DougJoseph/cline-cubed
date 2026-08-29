import { beforeEach, describe, expect, it } from "bun:test"
import {
	__resetChatSurfacesForTest,
	bindChatSurfaceToSession,
	chatSurfaceForSession,
	notifyChatTitleChanged,
	onChatTitleChanged,
	registerChatSurface,
	sessionForChatSurface,
	streamAcceptsSession,
	surfaceForStream,
	tagStreamWithSurface,
	unregisterChatSurface,
} from "./chat-surfaces"

/** Stand-in for a gRPC streaming subscription (identity is all the registry uses). */
const makeStream = () => () => {}

describe("chat surface registry", () => {
	beforeEach(() => {
		__resetChatSurfacesForTest()
	})

	it("registers a surface with no session by default", () => {
		registerChatSurface("a")
		expect(sessionForChatSurface("a")).toBe(null)
	})

	it("reports an unknown surface as undefined, distinct from a surface with no session", () => {
		registerChatSurface("a")
		expect(sessionForChatSurface("a")).toBe(null)
		expect(sessionForChatSurface("nope")).toBeUndefined()
	})

	it("does not clobber an existing binding when the surface re-registers", () => {
		registerChatSurface("a")
		bindChatSurfaceToSession("a", "session-1")
		registerChatSurface("a")
		expect(sessionForChatSurface("a")).toBe("session-1")
	})

	it("moves a session between surfaces instead of leaving both claiming it", () => {
		registerChatSurface("a")
		registerChatSurface("b")
		bindChatSurfaceToSession("a", "session-1")
		bindChatSurfaceToSession("b", "session-1")

		expect(sessionForChatSurface("b")).toBe("session-1")
		expect(sessionForChatSurface("a")).toBe(null)
		expect(chatSurfaceForSession("session-1")).toBe("b")
	})

	it("forgets a surface when its webview closes", () => {
		registerChatSurface("a")
		bindChatSurfaceToSession("a", "session-1")
		unregisterChatSurface("a")
		expect(sessionForChatSurface("a")).toBeUndefined()
		expect(chatSurfaceForSession("session-1")).toBeUndefined()
	})

	it("tags a stream with the surface that opened it", () => {
		const stream = makeStream()
		registerChatSurface("a")
		tagStreamWithSurface(stream, "a")
		expect(surfaceForStream(stream)).toBe("a")
	})

	describe("streamAcceptsSession", () => {
		it("delivers a session's content only to the surface showing it", () => {
			const streamA = makeStream()
			const streamB = makeStream()
			registerChatSurface("a")
			registerChatSurface("b")
			tagStreamWithSurface(streamA, "a")
			tagStreamWithSurface(streamB, "b")
			bindChatSurfaceToSession("a", "session-1")
			bindChatSurfaceToSession("b", "session-2")

			expect(streamAcceptsSession(streamA, "session-1")).toBe(true)
			expect(streamAcceptsSession(streamB, "session-1")).toBe(false)
			expect(streamAcceptsSession(streamA, "session-2")).toBe(false)
			expect(streamAcceptsSession(streamB, "session-2")).toBe(true)
		})

		it("withholds a conversation from a surface showing the new-chat home", () => {
			const stream = makeStream()
			registerChatSurface("a")
			tagStreamWithSurface(stream, "a")
			expect(sessionForChatSurface("a")).toBe(null)
			expect(streamAcceptsSession(stream, "session-1")).toBe(false)
		})

		it("delivers an unstamped message rather than dropping it", () => {
			// A message with no session stamp predates per-session routing. Dropping it would
			// silence content that has nowhere else to go; state delivery handles conversation
			// isolation separately, per surface.
			const stream = makeStream()
			registerChatSurface("a")
			tagStreamWithSurface(stream, "a")
			bindChatSurfaceToSession("a", "session-1")
			expect(streamAcceptsSession(stream, undefined)).toBe(true)
		})

		it("withholds every conversation from a surface showing the home, stamped or not", () => {
			const stream = makeStream()
			registerChatSurface("a")
			tagStreamWithSurface(stream, "a")
			expect(streamAcceptsSession(stream, "session-1")).toBe(false)
			expect(streamAcceptsSession(stream, undefined)).toBe(false)
		})

		it("keeps delivering everything to an untagged stream", () => {
			const stream = makeStream()
			expect(streamAcceptsSession(stream, "session-1")).toBe(true)
			expect(streamAcceptsSession(stream, undefined)).toBe(true)
		})

		it("keeps delivering everything to a stream whose surface was unregistered", () => {
			const stream = makeStream()
			registerChatSurface("a")
			tagStreamWithSurface(stream, "a")
			bindChatSurfaceToSession("a", "session-1")
			unregisterChatSurface("a")
			expect(streamAcceptsSession(stream, "session-2")).toBe(true)
		})
	})

	describe("chat name notifications", () => {
		it("tells every listener which chat changed", () => {
			const heard: string[] = []
			onChatTitleChanged((sessionId) => heard.push(`a:${sessionId}`))
			onChatTitleChanged((sessionId) => heard.push(`b:${sessionId}`))
			notifyChatTitleChanged("session-1")
			expect(heard).toEqual(["a:session-1", "b:session-1"])
		})

		it("stops telling a listener that has unsubscribed", () => {
			const heard: string[] = []
			const unsubscribe = onChatTitleChanged((sessionId) => heard.push(sessionId))
			notifyChatTitleChanged("session-1")
			unsubscribe()
			notifyChatTitleChanged("session-2")
			expect(heard).toEqual(["session-1"])
		})

		it("carries the session id ONLY — a listener resolves the name itself", () => {
			// Deliberate: a rename that CLEARS a name has no name to send, and a history write is
			// handed an item whose `title` is routinely undefined even for a named chat. Sending
			// either would relabel a tab wrongly, so listeners take one argument and look it up.
			const seen: unknown[][] = []
			onChatTitleChanged((...args) => seen.push(args))
			notifyChatTitleChanged("session-1")
			expect(seen).toEqual([["session-1"]])
		})
	})
})
