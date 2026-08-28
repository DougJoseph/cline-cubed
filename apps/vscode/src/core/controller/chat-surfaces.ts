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
	notifySurfacesChanged()
}

/** The session a surface displays. `undefined` = the surface is not registered. */
export function sessionForChatSurface(surfaceId: string): string | null | undefined {
	return surfaceSessions.get(surfaceId)
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
 * `undefined` target = the event is genuinely global (workspace-wide data), so everyone gets it.
 * An untagged stream has no surface identity and always receives events.
 */
export function streamIsTargeted(stream: object, targetSurfaceId: string | undefined): boolean {
	if (targetSurfaceId === undefined) {
		return true
	}
	const surfaceId = streamSurfaces.get(stream)
	if (surfaceId === undefined) {
		return true
	}
	return surfaceId === targetSurfaceId
}

/** Test seam — drops all registrations. */
export function __resetChatSurfacesForTest(): void {
	surfaceSessions.clear()
	evictionNotifiers.clear()
	surfacesChangedListeners.clear()
	activeChatSurfaceId = undefined
}
