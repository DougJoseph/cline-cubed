import { Logger } from "@/shared/services/Logger"

/**
 * Cline Cubed — image-bridge debug buffer.
 *
 * Every bridge call records one line here (cheap, in-memory, ring-buffered) so
 * the webview can show the most recent calls inline next to the bridge block.
 * The VS Code output-channel log is gated on the `imageBridgeDebugEnabled`
 * setting: the buffer records ALWAYS, the channel only when enabled. Failures
 * always reach the channel too — a broken bridge is never "debug noise."
 */

interface BridgeDebugEntry {
	ts: number
	line: string
	failed: boolean
}

const MAX_LINES = 20

const entries: BridgeDebugEntry[] = []

/**
 * Record a bridge debug line.
 * @param line  The human-readable line (no "[ImageBridge]" prefix — added here).
 * @param failed True when this line describes a failed bridge call.
 * @param debugEnabled Gate the output-channel log on the setting; the buffer
 *                     always records so inline display works without the toggle.
 */
export function recordBridgeDebug(line: string, failed: boolean, debugEnabled: boolean): void {
	entries.push({ ts: Date.now(), line, failed })
	if (entries.length > MAX_LINES) {
		entries.shift()
	}
	if (failed) {
		Logger.error(`[ImageBridge] ${line}`)
	} else if (debugEnabled) {
		Logger.log(`[ImageBridge] ${line}`)
	}
}

/** Most recent bridge debug lines, oldest → newest. */
export function getBridgeDebugLines(): string[] {
	return entries.map((entry) => entry.line)
}

/** Whether the most recent bridge call failed. */
export function isLastBridgeCallFailed(): boolean {
	return entries.length > 0 ? entries[entries.length - 1].failed : false
}
