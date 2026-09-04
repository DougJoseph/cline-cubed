/**
 * Chat surface routing registry.
 *
 * Cline Cubed runs multiple chat sessions side by side across three surfaces — the primary
 * sidebar, the secondary sidebar, and editor panel tabs. This registry is what keeps each
 * surface addressable: every chat webview is a "surface" with an id, each surface is bound to at
 * most one session, and each gRPC streaming subscription is tagged with the surface that opened
 * it. The send path then addresses individual surfaces, so a session's state and transcript go
 * only to the surface showing it.
 *
 * Deliberately VS Code-agnostic — no `vscode` import — because `core/controller` stays
 * host-neutral (the fork's lint rule) and this is imported from there.
 */

import { Logger } from "@/shared/services/Logger"

/** surfaceId → the session that surface displays. `null` = a new chat (the home), no session yet. */
const surfaceSessions = new Map<string, string | null>()

/**
 * Streaming subscription → the surface that opened it.
 *
 * A WeakMap keyed on the stream function: the gRPC layer already hands each surface its OWN
 * `postMessageToWebview`, so the stream closure IS a per-surface identity. Weak so a closed
 * webview's entry disappears with it.
 */
const streamSurfaces = new WeakMap<object, string>()

/**
 * Per-surface eviction notifiers. A session lives in exactly one surface, so binding it here
 * EVICTS it there — and the evicted surface's webview must be told, or it keeps rendering a
 * frozen copy of a chat that now lives elsewhere (its input still routes to the real session,
 * whose replies then appear only in the new location — a ghost). The hosts layer registers a
 * notifier per surface (it knows the webviews; this module stays host-neutral), and the
 * notifier tells that ONE webview to return to the New Chat home.
 */
const evictionNotifiers = new Map<string, () => void>()

/** Register the callback that tells a surface's webview its session moved elsewhere. */
export function setChatSurfaceEvictionNotifier(surfaceId: string, notify: () => void): void {
	evictionNotifiers.set(surfaceId, notify)
}

/**
 * Listeners told whenever the surface↔session map changes.
 *
 * The chats list renders which chat is open where, so it has to hear about every bind, unbind and
 * surface teardown rather than poll for them.
 */
const surfacesChangedListeners = new Set<() => void>()

/** Subscribe to surface↔session changes. Returns an unsubscribe function. */
export function onChatSurfacesChanged(listener: () => void): () => void {
	surfacesChangedListeners.add(listener)
	return () => {
		surfacesChangedListeners.delete(listener)
	}
}

function notifySurfacesChanged(): void {
	for (const listener of surfacesChangedListeners) {
		listener()
	}
}

/**
 * Listeners told that a chat's DISPLAYED NAME may have changed.
 *
 * This lives beside the surface registry for the same reason the eviction notifier does: the host
 * layer owns things that carry a chat's name in their own chrome — an editor tab title — and the
 * controller must be able to say "this chat's name moved" without importing `vscode`.
 *
 * It carries the session id ONLY, deliberately. Two callers fire it and neither is holding the
 * resolved name: a rename knows the raw input (which is empty when a name is CLEARED, and the
 * displayed name is then the first prompt), and a history write is handed a `HistoryItem` whose
 * `title` is routinely undefined even for a named chat — announcing that item's display name would
 * wipe a real name off the tab. So each listener resolves the name itself, which also means the
 * lookup is paid only when something is actually showing that chat.
 */
const chatTitleListeners = new Set<(sessionId: string) => void>()

/** Subscribe to chat-name changes. Returns an unsubscribe function. */
export function onChatTitleChanged(listener: (sessionId: string) => void): () => void {
	chatTitleListeners.add(listener)
	return () => {
		chatTitleListeners.delete(listener)
	}
}

/** Announce that a chat's displayed name may have changed; listeners re-resolve it. */
export function notifyChatTitleChanged(sessionId: string): void {
	for (const listener of chatTitleListeners) {
		listener(sessionId)
	}
}

/** Every surface that currently displays a session, as `[surfaceId, sessionId]` pairs. */
export function openChatSurfaces(): Array<{ surfaceId: string; sessionId: string }> {
	const open: Array<{ surfaceId: string; sessionId: string }> = []
	for (const [surfaceId, sessionId] of surfaceSessions) {
		if (typeof sessionId === "string") {
			open.push({ surfaceId, sessionId })
		}
	}
	return open
}

/** Register a chat surface. Idempotent; re-registering preserves an existing binding. */
export function registerChatSurface(surfaceId: string, sessionId: string | null = null): void {
	if (!surfaceSessions.has(surfaceId)) {
		surfaceSessions.set(surfaceId, sessionId)
		notifySurfacesChanged()
	}
}

/** Forget a surface (its webview closed). */
export function unregisterChatSurface(surfaceId: string): void {
	surfaceSessions.delete(surfaceId)
	evictionNotifiers.delete(surfaceId)
	clearActiveChatSurface(surfaceId)
	notifySurfacesChanged()
}

/**
 * Bind a surface to a session, evicting stale bindings in BOTH directions.
 *
 * A session lives in exactly one surface, and a surface shows exactly one session, so reopening
 * a session somewhere else moves it rather than duplicating it. The evicted surface is notified
 * so its webview steps back to the New Chat home instead of freezing on a stale transcript.
 */
export function bindChatSurfaceToSession(surfaceId: string, sessionId: string | null): void {
	if (sessionId !== null) {
		for (const [otherSurface, otherSession] of surfaceSessions) {
			if (otherSurface !== surfaceId && otherSession === sessionId) {
				surfaceSessions.set(otherSurface, null)
				evictionNotifiers.get(otherSurface)?.()
			}
		}
	}
	surfaceSessions.set(surfaceId, sessionId)
	// A chat was just put HERE — by an open from the history list, an adopt into a sidebar, a
	// new task binding its own panel. That is the person choosing where they are working, which
	// focus and visibility events cannot see: a chat adopted into a sidebar that was already
	// showing fires no visibility change at all. Releasing to null (eviction, close) claims nothing.
	if (sessionId !== null) {
		setActiveChatSurface(surfaceId)
	}
	notifySurfacesChanged()
}

/** The session a surface displays. `undefined` = the surface is not registered. */
export function sessionForChatSurface(surfaceId: string): string | null | undefined {
	return surfaceSessions.get(surfaceId)
}

/**
 * Sessions whose conversation is being LOADED right now — a restore after a window reload, or
 * a slow open from History. RECORDED by the thing that starts the load, never inferred: a
 * failed proxy lookup cannot tell "loading" from "gone", so without this mark the state
 * builder used to answer "empty chat" for a chat that was seconds from arriving (the
 * title-then-Home reload bug, Doug 2026-08-31). A Set, so double-marking is harmless.
 */
const restoringSessions = new Set<string>()

/** Record that a load is in flight for this session — called AT QUEUE TIME, before any webview
 *  can ask, so there is no front-side race. */
export function markSessionRestoring(sessionId: string): void {
	restoringSessions.add(sessionId)
}

/** The load finished or failed — either way it is no longer in flight. */
export function clearSessionRestoring(sessionId: string): void {
	restoringSessions.delete(sessionId)
}

/** Is a load in flight for this session? Read by the state builder to give its third answer. */
export function isSessionRestoring(sessionId: string): boolean {
	return restoringSessions.has(sessionId)
}

/**
 * Send the surface showing `sessionId` (if any) back to its Home, releasing the binding.
 *
 * The deletion counterpart of eviction: when a session is deleted, the surface rendering it
 * must not keep showing a chat that no longer exists — typing there would silently start a
 * NEW chat behind a dead transcript. Reuses the per-surface eviction notifier, which resets
 * the webview's replica properly (panels also release their task claim first). A session
 * shown nowhere is a no-op.
 */
export function evictSessionFromItsSurface(sessionId: string): void {
	let changed = false
	for (const [surfaceId, boundSession] of surfaceSessions) {
		if (boundSession === sessionId) {
			surfaceSessions.set(surfaceId, null)
			evictionNotifiers.get(surfaceId)?.()
			changed = true
		}
	}
	if (changed) {
		notifySurfacesChanged()
	}
}

/** The surface currently showing a session, if any. */
export function chatSurfaceForSession(sessionId: string): string | undefined {
	for (const [surfaceId, boundSession] of surfaceSessions) {
		if (boundSession === sessionId) {
			return surfaceId
		}
	}
	return undefined
}

/** Tag a streaming subscription with the surface that opened it. */
export function tagStreamWithSurface(stream: object, surfaceId: string): void {
	streamSurfaces.set(stream, surfaceId)
}

/** The surface that opened a subscription, if it was tagged. */
export function surfaceForStream(stream: object): string | undefined {
	return streamSurfaces.get(stream)
}

/**
 * The session a subscription's surface is showing.
 *
 * Returns `undefined` when the stream has no surface identity at all (the standalone host, the
 * CLI, tests) — such a consumer is outside the per-surface model and receives whatever the host
 * sends. Returns `null` when the surface is showing the new-chat home.
 */
export function sessionForStream(stream: object): string | null | undefined {
	const surfaceId = streamSurfaces.get(stream)
	if (surfaceId === undefined) {
		return undefined
	}
	return surfaceSessions.get(surfaceId)
}

/**
 * Should this subscription receive conversation content belonging to `sessionId`?
 *
 * Used for the transcript channel, where a message unambiguously belongs to one session.
 * An untagged stream receives everything; a surface showing the home receives no conversation.
 */
export function streamAcceptsSession(stream: object, sessionId: string | null | undefined): boolean {
	const surfaceSession = sessionForStream(stream)
	if (surfaceSession === undefined) {
		return true
	}
	if (surfaceSession === null) {
		return false
	}
	// An unstamped message predates per-session routing; deliver it rather than dropping it.
	if (sessionId === undefined) {
		return true
	}
	return surfaceSession === sessionId
}

/**
 * The chat surface the user is currently working in.
 *
 * A command-palette action, a toolbar button or an @-mention is aimed at the chat in front of the
 * user — not at every chat that happens to be open. Surfaces claim this as they become visible.
 */
let activeChatSurfaceId: string | undefined

/** Mark a surface as the one the user is working in. */
export function setActiveChatSurface(surfaceId: string): void {
	activeChatSurfaceId = surfaceId
}

/** The surface the user is working in, if one is known. */
export function getActiveChatSurface(): string | undefined {
	return activeChatSurfaceId
}

/** Release the active claim when a surface goes away. */
export function clearActiveChatSurface(surfaceId: string): void {
	if (activeChatSurfaceId === surfaceId) {
		activeChatSurfaceId = undefined
	}
}

/**
 * Should this subscription receive an event aimed at `targetSurfaceId`?
 *
 * Only when the target is known, the stream is tagged, and the two agree. Every event that asks
 * this question is a per-chat gesture — a focus, an insert, a navigation button — so there is no
 * reading in which "no target" means "all of them": one person's Add to Chat arriving in every
 * open chat is the worst answer available. Genuinely workspace-wide data never comes through
 * here; its senders take no target and ask no question.
 */
export function streamIsTargeted(stream: object, targetSurfaceId: string | undefined): boolean {
	if (targetSurfaceId === undefined) {
		return false
	}
	return streamSurfaces.get(stream) === targetSurfaceId
}

/**
 * Whether a per-chat event may be sent at all. Called once per send, before the per-stream
 * filter: an event with no target reaches nobody, and the fact is recorded at ERROR — this is a
 * real failure of routing, never debug noise — so it shows up as a missing insert or focus with a
 * line in the log naming it, rather than as the same text in every chat.
 */
export function requireTargetSurface(eventName: string, targetSurfaceId: string | undefined): targetSurfaceId is string {
	if (targetSurfaceId !== undefined) {
		return true
	}
	Logger.error(`[chat-surfaces] ${eventName} has no target surface; delivered to nobody`)
	return false
}

/** Test seam — drops all registrations. */
export function __resetChatSurfacesForTest(): void {
	surfaceSessions.clear()
	evictionNotifiers.clear()
	surfacesChangedListeners.clear()
	chatTitleListeners.clear()
	activeChatSurfaceId = undefined
}
