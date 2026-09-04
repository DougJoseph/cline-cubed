/**
 * Cline Cubed — Stage B1 collector: drive the automatable close-gesture rows and print, for
 * each, exactly which lifecycle events fired and in what order (from the IS_DEV
 * lifecycle-table.jsonl the instrumented handlers append to).
 *
 * NOT a pass/fail scenario — it produces the reality table the plan's Part B designs from.
 * The drag rows cannot be driven here; Doug fills those in one guided pass.
 *
 * PREREQUISITES: dev build + server running (see scenarios/README pattern).
 * RUN: bun src/dev/debug-harness/collect-lifecycle-table.ts
 */

import * as fs from "node:fs"
import * as path from "node:path"
import {
	api,
	CHAT_LOCATION,
	extEval,
	freshApp,
	liveTaskShims,
	openChat,
	pressInChatClose,
	reloadWindow,
	sendInto,
	sleep,
	surfaceIds,
	waitForQuiet,
	waitForText,
} from "./scenarios/harness"

/** Drive a VS Code command by EXACT id — no palette typed-name fuzziness. */
async function runCommand(id: string): Promise<void> {
	await extEval(`globalThis.__clineCubedDebug.executeCommand(${JSON.stringify(id)}).then(() => "ok")`)
}

/** The CONSEQUENCE probe: which sessions are still live after a gesture. */
async function liveNow(): Promise<string> {
	try {
		const shims = await liveTaskShims()
		return shims.length === 0 ? "live sessions: NONE" : `live sessions: ${shims.map((s) => s.id).join(", ")}`
	} catch (e: any) {
		return `live sessions: unreadable (${e?.message ?? e})`
	}
}

let logFile = ""
let offset = 0

function readNew(): string[] {
	try {
		const lines = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean)
		const fresh = lines.slice(offset)
		offset = lines.length
		return fresh
	} catch {
		return []
	}
}

function printRow(name: string, lines: string[]): void {
	console.log(`\n═══ ${name} ═══`)
	if (lines.length === 0) {
		console.log("  (no lifecycle events fired)")
		return
	}
	for (const line of lines) {
		try {
			const e = JSON.parse(line)
			const { seq, t, source, ...rest } = e
			console.log(`  #${seq} ${source}  ${JSON.stringify(rest)}`)
		} catch {
			console.log(`  ${line}`)
		}
	}
}

async function gesture(name: string, act: () => Promise<void>, settleMs = 3000): Promise<void> {
	readNew() // drain anything pending before the gesture
	try {
		await act()
	} catch (error: any) {
		console.log(`\n═══ ${name} ═══\n  GESTURE FAILED TO RUN: ${error?.message ?? error}`)
		return
	}
	await sleep(settleMs) // long enough for the sidebar's 1.5s timer verdict
	printRow(name, readNew())
	console.log(`  → ${await liveNow()}`)
}

async function main(): Promise<void> {
	console.log("\nCline Cubed — close-gesture reality table (automatable rows)\n")

	// ── Part 1: editor-tab gestures ────────────────────────────────────────────────────────
	await freshApp({ newChatLocation: CHAT_LOCATION.editor })
	const status = await api("status")
	logFile = path.join(String(status.clineDir ?? ""), "data", "lifecycle-table.jsonl")
	console.log(`table file: ${logFile}`)
	offset = 0
	readNew() // skip launch noise up to here
	printRow("startup (editor location, no chats yet) — trailing events", [])

	const a = await openChat("chat A")
	await sendInto(a, "TABLE-A")
	await waitForText(a, "TABLE-A", 30000)
	await waitForQuiet(a)
	printRow("open chat A (editor tab) + one turn", readNew())

	const b = await openChat("chat B")
	await sendInto(b, "TABLE-B")
	await waitForText(b, "TABLE-B", 30000)
	await waitForQuiet(b)
	printRow("open chat B (second editor tab) + one turn", readNew())
	console.log(`  → ${await liveNow()}`)

	await gesture("tab X on the ACTIVE tab (Cmd+W)", async () => {
		await api("ui.press", { key: "Meta+w" })
	})

	await gesture('group "…" → Close All (workbench.action.closeEditorsInGroup)', async () => {
		await runCommand("workbench.action.closeEditorsInGroup")
	})

	const c = await openChat("chat C")
	await sendInto(c, "TABLE-C")
	await waitForText(c, "TABLE-C", 30000)
	await waitForQuiet(c)
	readNew()
	await gesture("in-chat X (the chat's own close control)", async () => {
		await pressInChatClose(c)
	})

	// ── Part 2: docked-sidebar gestures ────────────────────────────────────────────────────
	await freshApp({ newChatLocation: CHAT_LOCATION.secondarySidebar })
	offset = 0
	readNew()
	const d = await openChat("docked chat")
	await sendInto(d, "TABLE-D")
	await waitForText(d, "TABLE-D", 30000)
	await waitForQuiet(d)
	printRow("open docked chat (secondary sidebar) + one turn", readNew())

	await gesture(
		"window reload (docked chat present and LIVE)",
		async () => {
			await reloadWindow()
		},
		5000,
	)
	console.log(`surfaces after reload: ${(await surfaceIds().catch(() => [])).join(", ") || "(none yet)"}`)
	await sleep(5000)
	printRow("post-reload trailing events (restore settling)", readNew())
	console.log(`  → ${await liveNow()}`)

	await gesture(
		"hide the secondary sidebar — RESTORED (bound, not live) chat in it",
		async () => {
			await runCommand("workbench.action.toggleAuxiliaryBar")
		},
		4000,
	)

	await gesture(
		"show the secondary sidebar again (toggle back)",
		async () => {
			await runCommand("workbench.action.toggleAuxiliaryBar")
		},
		4000,
	)

	const e = await openChat("docked chat 2 (live)")
	await sendInto(e, "TABLE-E")
	await waitForText(e, "TABLE-E", 30000)
	await waitForQuiet(e)
	readNew()

	await gesture(
		"hide the secondary sidebar — LIVE chat in it (toggleAuxiliaryBar)",
		async () => {
			await runCommand("workbench.action.toggleAuxiliaryBar")
		},
		4000,
	)

	await gesture(
		"close the secondary sidebar (workbench.action.closeAuxiliaryBar)",
		async () => {
			await runCommand("workbench.action.closeAuxiliaryBar")
		},
		4000,
	)

	await gesture(
		"window close (shutdown)",
		async () => {
			await api("shutdown")
		},
		4000,
	)

	console.log("\ndone — drag rows and the sidebar X (mouse-only) come from Doug's guided pass\n")
}

main().catch((err) => {
	console.error(`collector aborted: ${err.message}`)
	process.exit(2)
})
