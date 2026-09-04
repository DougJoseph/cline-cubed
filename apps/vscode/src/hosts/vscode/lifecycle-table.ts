import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Logger } from "@/shared/services/Logger"

/**
 * Cline Cubed — Stage B1 instrumentation for the close-gesture reality table (plan:
 * Docs/2026-08-31_7.49pm_conversation-has-three-states-and-closes-are-facts-not-guesses.md).
 *
 * The lifecycle handlers infer "the user closed this chat" from events that fire for many
 * unrelated reasons; before any of that is redesigned, this records what ACTUALLY fires, in
 * what order, for each gesture in the matrix — a tab's X, the group's "…" → Close All, the
 * sidebar's X, hides, drags, reloads, window close, startup.
 *
 * Gated on the master debug-logging switch (General Settings → Debug logging), NOT on IS_DEV, so
 * a close-gesture question can be answered on an installed build instead of only in the harness:
 * turn logging on, make the gesture, read the file, turn it off. Off by default — a shipped build
 * with the setting untouched writes nothing.
 *
 * Events go to TWO places, deliberately:
 *
 *  - as JSON lines to `<CLINE_DIR>/data/lifecycle-table.jsonl`, each with a process-monotonic
 *    sequence number and timestamp so interleavings are unambiguous. The file survives the window
 *    closing, which is the only way the shutdown rows can ever be read;
 *  - and to the output channel via `Logger.debug`, so the answer to "did closing that tab end the
 *    chat?" is readable where a person is already looking, instead of only in a file they have to
 *    know about and go open.
 *
 * The file is not redundant with the channel: the channel is cleared, scrolls, and dies with the
 * window, and the shutdown events are written while it is going away.
 */
let seq = 0
const filePath = path.join(process.env.CLINE_DIR?.trim() || path.join(os.homedir(), ".cline"), "data", "lifecycle-table.jsonl")

export function recordLifecycleEvent(source: string, detail: Record<string, unknown> = {}): void {
	if (!Logger.isDebugEnabled()) {
		return
	}
	const event = { seq: ++seq, t: Date.now(), source, ...detail }
	try {
		fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`)
	} catch {
		// Recording is diagnostic only — never let it interfere with the event being recorded.
	}
	// Same event, same sequence number, so a line in the channel and a line in the file can be
	// matched to each other. Logger.debug re-checks the switch, which is harmless.
	Logger.debug(`[lifecycle] ${JSON.stringify(event)}`)
}
