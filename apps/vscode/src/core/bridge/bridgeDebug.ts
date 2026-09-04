import { Logger } from "@/shared/services/Logger"

/**
 * Cline Cubed — image-bridge debug buffer.
 *
 * Every bridge call records one line here (cheap, in-memory, ring-buffered) so the webview can
 * show what happened next to the bridge block in the chat. The VS Code output-channel log is gated
 * on the master `debugLoggingEnabled` setting: the buffer records ALWAYS, the channel only when
 * enabled. Failures always reach the channel too — a broken bridge is never "debug noise."
 *
 * ENTRIES BELONG TO A SUBMISSION. The buffer is one list for the whole extension, while each panel
 * speaks for a single message, so lines are grouped by the interception run that produced them and
 * a panel is given only its own. A line that is a true statement about one message reads, under
 * another, as a claim about that one — and a display that says nothing is better than a display
 * that says something untrue about a person's own work.
 */

interface BridgeDebugEntry {
	ts: number
	line: string
	failed: boolean
	/** The interception run this line came from. See `beginBridgeSubmission`. */
	submission: number
}

/** One line as the webview receives it — the time is kept, so a line is anchored to a moment. */
export interface BridgeDebugLine {
	ts: number
	line: string
	failed: boolean
}

/** One interception run's lines, with what identifies the message that caused them. */
export interface BridgeDebugSubmission {
	/** This run's number — unique for the life of the extension host, stable while it is retained. */
	submission: number
	/**
	 * The chat this run belongs to, when it is known. A panel in a DIFFERENT chat must never show
	 * these lines — timing alone cannot rule that out, since a message in one chat can easily be
	 * created after a bridge run in another.
	 *
	 * Undefined only for a run that started a brand-new chat, where no session exists yet; that run
	 * is claimed by `attachBridgeSubmissionToSession` as soon as the chat is created.
	 */
	sessionId?: string
	/** When this run started. Within its own chat, a message created BEFORE this cannot own it. */
	startedAt: number
	lines: BridgeDebugLine[]
	lastFailed: boolean
}

/** A run's identity, kept for as long as any of its lines are still retained. */
interface BridgeDebugRun {
	submission: number
	sessionId?: string
	startedAt: number
}

const MAX_LINES = 20

/**
 * How many runs stay reachable at once.
 *
 * A run begins on EVERY send — the interception entry point starts one before it can know whether
 * there are images to bridge — so runs accumulate at the pace of the conversation. Several are kept
 * because a panel is attached to a message that stays on screen: it has to go on finding its own
 * run once later messages have been sent. Ten covers looking back over the recent part of a chat,
 * which is when anyone reads this, without holding diagnostic text indefinitely.
 */
const MAX_RUNS = 10

const entries: BridgeDebugEntry[] = []
const runs: BridgeDebugRun[] = []
let currentSubmission = 0

/**
 * Start a new interception run. Called once per submission by the interception entry point, so the
 * lines it records are attributable to the message that submission produces.
 *
 * @param sessionId The chat this submission belongs to, where the caller knows it. Sending into an
 *                  existing chat does; starting a NEW chat does not, because the chat is created
 *                  from the bridged text afterwards — that case calls
 *                  `attachBridgeSubmissionToSession` once the id exists.
 */
export function beginBridgeSubmission(sessionId?: string): void {
	currentSubmission += 1
	runs.push({ submission: currentSubmission, sessionId, startedAt: Date.now() })
	if (runs.length > MAX_RUNS) {
		runs.shift()
	}
}

/**
 * Name the chat the current run belongs to, for the new-chat path where the id only exists after
 * the bridge has already run. Ignored once a later run has begun — a stale claim must not relabel
 * somebody else's lines.
 */
export function attachBridgeSubmissionToSession(sessionId: string, submissionAtCall = currentSubmission): void {
	if (submissionAtCall !== currentSubmission || !sessionId) {
		return
	}
	const run = runs[runs.length - 1]
	if (run?.submission === currentSubmission) {
		run.sessionId = sessionId
	}
}

/** The run number in flight, so a caller can claim the run it started and no other. */
export function currentBridgeSubmission(): number {
	return currentSubmission
}

/**
 * Record a bridge debug line.
 * @param line  The human-readable line (no "[ImageBridge]" prefix — added here).
 * @param failed True when this line describes a failed bridge call.
 * @param debugEnabled Gate the output-channel log on the master setting; the buffer always records
 *                     so the inline display works whether or not logging is on.
 */
export function recordBridgeDebug(line: string, failed: boolean, debugEnabled: boolean): void {
	entries.push({ ts: Date.now(), line, failed, submission: currentSubmission })
	if (entries.length > MAX_LINES) {
		entries.shift()
	}
	if (failed) {
		Logger.error(`[ImageBridge] ${line}`)
	} else if (debugEnabled) {
		Logger.log(`[ImageBridge] ${line}`)
	}
}

/**
 * Every retained run that still has lines, oldest run first, each run's lines oldest → newest.
 *
 * Deliberately grouped BY RUN rather than handed over as "the last N lines": the webview decides
 * which run the message it is rendering can own (a message created before a run started cannot own
 * it), and it can only make that decision honestly if each group it receives comes from one run.
 *
 * Runs whose lines have all been evicted by the line cap are omitted — an empty group would say
 * nothing and could not be matched to anything.
 */
export function getBridgeDebugRuns(): BridgeDebugSubmission[] {
	const linesByRun = new Map<number, BridgeDebugLine[]>()
	for (const { ts, line, failed, submission } of entries) {
		const existing = linesByRun.get(submission)
		if (existing) {
			existing.push({ ts, line, failed })
		} else {
			linesByRun.set(submission, [{ ts, line, failed }])
		}
	}

	const result: BridgeDebugSubmission[] = []
	for (const run of runs) {
		const lines = linesByRun.get(run.submission)
		if (!lines || lines.length === 0) {
			continue
		}
		result.push({
			submission: run.submission,
			sessionId: run.sessionId,
			startedAt: run.startedAt,
			lines,
			lastFailed: lines[lines.length - 1].failed,
		})
	}
	return result
}
