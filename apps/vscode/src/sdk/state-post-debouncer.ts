// Coalesces frequent postStateToWebview() requests into a single trailing
// rebuild. During a streaming turn the session event coordinator can fire
// postStateToWebview() many times per second; each call rebuilds the full
// ExtensionState (including task history), which is expensive enough to
// saturate the extension host event loop if run on every event. This class
// owns the debounce timer, in-flight/queued bookkeeping, and the resolver
// list, extracted from SdkController so the concurrency behavior can be unit
// tested in isolation.
import { Logger } from "@/shared/services/Logger"

export interface StatePostDebouncerOptions {
	/** Trailing debounce window: bursts of post() calls within this window collapse into one flush. */
	debounceMs: number
	/**
	 * Builds and ships the current state snapshot for the given session.
	 * `sessionId` is the SESSION whose state the caller wants shipped (undefined = the
	 * focused session). Rejections propagate to post() callers.
	 */
	flush: (sessionId?: string) => Promise<void>
}

/**
 * Debounce/coalesce state posts.
 *
 * `post()` resolves once a snapshot reflecting that call has been shipped (or
 * rejects if the flush that shipped it failed — errors are not swallowed, so
 * callers awaiting `post()` can tell a state update did not reach the
 * webview). Requests arriving while a flush is in flight are folded into
 * `queued`; exactly one more flush runs afterward so the final snapshot is
 * never stale.
 *
 * Cline Cubed: per-session. Each `post(sessionId)` records that session;
 * the trailing flush drains ALL pending sessions (each gets its own state
 * snapshot) so concurrent chats never starve each other's panel updates.
 */
export class StatePostDebouncer {
	private debounceTimer?: NodeJS.Timeout
	private inFlight = false
	private inFlightPromise?: Promise<void>
	private queued = false
	private pendingResolvers: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
	/** Sessions whose state snapshots are pending shipment (V7). */
	private pendingSessionIds = new Set<string>()
	/** A pending unbound (focused-session) snapshot request. */
	private pendingGlobal = false
	private disposed = false

	constructor(private readonly options: StatePostDebouncerOptions) {}

	post(sessionId?: string): Promise<void> {
		if (this.disposed) {
			return Promise.resolve()
		}
		if (sessionId) {
			this.pendingSessionIds.add(sessionId)
		} else {
			this.pendingGlobal = true
		}
		return new Promise<void>((resolve, reject) => {
			this.pendingResolvers.push({ resolve, reject })
			if (this.debounceTimer) {
				return
			}
			this.debounceTimer = setTimeout(() => {
				this.debounceTimer = undefined
				// If a flush loop is already running, runDebounced() just folds this
				// request into it (via `queued`) and returns a throwaway resolved
				// promise without doing any work. Only track the promise from the
				// call that actually starts the flush loop — otherwise that trivial
				// promise would overwrite the reference to the real, still-running
				// flush, and dispose() could await the wrong one and return while
				// the original flush is still executing.
				const isStartingNewFlush = !this.inFlight
				const runPromise = this.runDebounced()
				if (isStartingNewFlush) {
					this.inFlightPromise = runPromise
				}
			}, this.options.debounceMs)
			this.debounceTimer.unref?.()
		})
	}

	private async runDebounced(): Promise<void> {
		if (this.inFlight) {
			this.queued = true
			return
		}
		this.inFlight = true
		try {
			do {
				this.queued = false
				const resolvers = this.pendingResolvers
				this.pendingResolvers = []
				// Drain per-session snapshot requests (V7): every pending session gets a
				// state post so no concurrent chat's panel is starved by another's.
				const sessionIds = [...this.pendingSessionIds]
				this.pendingSessionIds.clear()
				const global = this.pendingGlobal
				this.pendingGlobal = false
				try {
					if (global) {
						await this.options.flush(undefined)
					}
					for (const sessionId of sessionIds) {
						await this.options.flush(sessionId)
					}
					for (const { resolve } of resolvers) {
						resolve()
					}
				} catch (error) {
					// Preserve rejection semantics: callers awaiting post() must see
					// the failure, not a silent success, so command handlers don't
					// assume the webview received a fresh snapshot when it didn't.
					Logger.error("[StatePostDebouncer] Failed to post state to webview:", error)
					for (const { reject } of resolvers) {
						reject(error)
					}
				}
			} while (this.queued && !this.disposed)
		} finally {
			this.inFlight = false
			this.inFlightPromise = undefined
		}
	}

	/**
	 * Tear down the debounce machinery: cancel any pending timer and settle
	 * in-flight awaiters so callers blocked on `post()` don't hang past
	 * disposal. Awaits any flush that's still executing so it either completes
	 * or bails via the `disposed` guard before the caller tears down downstream
	 * resources.
	 */
	async dispose(): Promise<void> {
		this.disposed = true
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
			this.debounceTimer = undefined
		}
		this.queued = false
		const pendingResolvers = this.pendingResolvers
		this.pendingResolvers = []
		for (const { resolve } of pendingResolvers) {
			resolve()
		}
		const inFlight = this.inFlightPromise
		if (inFlight) {
			await inFlight.catch(() => {})
			this.inFlightPromise = undefined
		}
	}
}
