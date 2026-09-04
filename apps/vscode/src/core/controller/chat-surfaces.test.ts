import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { Logger } from "@/shared/services/Logger"
import {
	__resetChatSurfacesForTest,
	bindChatSurfaceToSession,
	chatSurfaceForSession,
	getActiveChatSurface,
	notifyChatTitleChanged,
	onChatTitleChanged,
	registerChatSurface,
	requireTargetSurface,
	sessionForChatSurface,
	setActiveChatSurface,
	streamAcceptsSession,
	streamIsTargeted,
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

	/**
	 * Which chat a per-chat EVENT reaches. Distinct from `streamAcceptsSession` above, which
	 * governs a session's own content: that one keeps delivering to an untagged stream because
	 * a conversation with nowhere to go is worse than one delivered broadly. A gesture is the
	 * opposite case — a focus, an insert, a navigation button belongs to exactly one chat, and
	 * one person's gesture arriving in every open chat is the worst answer available. So this
	 * predicate fails closed on every doubt.
	 */
	describe("streamIsTargeted", () => {
		it("delivers to a tagged stream whose surface is the target", () => {
			const stream = makeStream()
			tagStreamWithSurface(stream, "a")
			expect(streamIsTargeted(stream, "a")).toBe(true)
		})

		it("withholds from a tagged stream whose surface is not the target", () => {
			const stream = makeStream()
			tagStreamWithSurface(stream, "a")
			expect(streamIsTargeted(stream, "b")).toBe(false)
		})

		it("withholds from EVERYONE when the target is undefined — no target is not every target", () => {
			const a = makeStream()
			const b = makeStream()
			tagStreamWithSurface(a, "a")
			tagStreamWithSurface(b, "b")
			expect(streamIsTargeted(a, undefined)).toBe(false)
			expect(streamIsTargeted(b, undefined)).toBe(false)
		})

		it("withholds from an untagged stream, whatever the target", () => {
			const untagged = makeStream()
			expect(streamIsTargeted(untagged, "a")).toBe(false)
			expect(streamIsTargeted(untagged, undefined)).toBe(false)
		})
	})

	describe("requireTargetSurface", () => {
		let errorSpy: ReturnType<typeof spyOn>
		beforeEach(() => {
			errorSpy = spyOn(Logger, "error").mockImplementation(() => {})
		})
		afterEach(() => {
			errorSpy.mockRestore()
		})

		it("allows a defined target and records nothing", () => {
			expect(requireTargetSurface("addToInput", "a")).toBe(true)
			expect(errorSpy.mock.calls.length).toBe(0)
		})

		it("refuses an undefined target and records it at ERROR, naming the event", () => {
			// A gesture that reaches nobody must leave a line saying so — a missing insert with a
			// named cause is diagnosable; the same insert appearing in every chat is not.
			expect(requireTargetSurface("addToInput", undefined)).toBe(false)
			expect(errorSpy.mock.calls.length).toBe(1)
			const line = String(errorSpy.mock.calls[0][0])
			expect(line).toContain("addToInput")
			expect(line).toContain("no target surface")
		})
	})

	/**
	 * Which chat the person is WORKING IN. Focus and visibility events, which the hosts already
	 * report, cannot see the two acts that say it without ambiguity: a chat being put into a
	 * surface, and a message being sent from one. A chat adopted into a sidebar that is already
	 * showing fires no visibility change at all, so without the bind claim below it is never the
	 * chat a command aims at.
	 */
	describe("the active chat surface", () => {
		it("is claimed by a surface when a session is bound into it", () => {
			registerChatSurface("sidebar")
			expect(getActiveChatSurface()).toBeUndefined()
			bindChatSurfaceToSession("sidebar", "session-1")
			expect(getActiveChatSurface()).toBe("sidebar")
		})

		it("is NOT claimed by a surface releasing to null", () => {
			registerChatSurface("tab-1")
			registerChatSurface("tab-2")
			bindChatSurfaceToSession("tab-1", "session-1")
			// The in-chat close: tab-2 goes back to the home. That says nothing about where the
			// person is working, so the slot stays where it was.
			bindChatSurfaceToSession("tab-2", null)
			expect(getActiveChatSurface()).toBe("tab-1")
		})

		it("follows a session that is moved — the surface it lands in becomes active", () => {
			registerChatSurface("tab-1")
			registerChatSurface("sidebar")
			bindChatSurfaceToSession("tab-1", "session-1")
			expect(getActiveChatSurface()).toBe("tab-1")
			bindChatSurfaceToSession("sidebar", "session-1")
			expect(getActiveChatSurface()).toBe("sidebar")
		})

		it("is released when the surface holding it closes", () => {
			registerChatSurface("tab-1")
			setActiveChatSurface("tab-1")
			unregisterChatSurface("tab-1")
			expect(getActiveChatSurface()).toBeUndefined()
		})

		it("is NOT released when some other surface closes", () => {
			registerChatSurface("tab-1")
			registerChatSurface("tab-2")
			setActiveChatSurface("tab-1")
			unregisterChatSurface("tab-2")
			expect(getActiveChatSurface()).toBe("tab-1")
		})
	})
})
