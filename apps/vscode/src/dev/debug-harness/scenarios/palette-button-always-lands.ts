/**
 * Cline Cubed — a palette button always has a chat to land in.
 *
 * The chat view's toolbar commands (Settings, History, MCP Servers, Marketplace, Account,
 * Worktrees) can be run from the command palette. Each follows the same rule as Jump to Chat
 * Input: bring the working surface into view — or, when none is known, the configured location —
 * and deliver to the surface that was revealed. The case this pins is "none is known": the tab
 * the person was working in has just been closed, another chat is still open, and nothing has
 * been tapped or sent since. The command must open the configured location and show its view
 * there, rather than deliver to nobody.
 *
 * Judged by the working surface the extension host reports after the command, by the surface
 * set (nothing spawned), and by the Settings view's own text appearing in the revealed surface.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node --experimental-strip-types src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/palette-button-always-lands.ts
 *
 * Exit code 0 = all assertions passed, 1 = an assertion failed, 2 = the scenario could not run.
 */

import {
	api,
	assert,
	CHAT_LOCATION,
	closeEditorTabByX,
	extEval,
	frameOf,
	freshApp,
	openChat,
	report,
	run,
	runCommand,
	sendInto,
	sleep,
	surfaceIds,
	waitForQuiet,
	waitForText,
} from "./harness"

const RUN_ID = Date.now()
const TAB_MARK = `TAB-${RUN_ID}`
const inSecondary = (id: string) => id.startsWith("secondary-sidebar")

async function activeSurface(): Promise<string | undefined> {
	return extEval<string | undefined>("globalThis.__clineCubedDebug.activeChatSurface()")
}

/** The whole visible text of one surface — a settings view, not a chat transcript. */
async function surfaceText(surfaceId: string): Promise<string> {
	const res = await api("ui.get_text", { frame: frameOf(surfaceId), selector: "body" })
	return String(res?.text ?? "")
}

async function main(): Promise<void> {
	console.log(`\nCline Cubed — a palette button always lands somewhere\nrun: ${RUN_ID}\n`)
	await freshApp({ newChatLocation: CHAT_LOCATION.secondarySidebar })

	const sidebar = await openChat("sidebar chat")
	assert("1. the first chat landed in the secondary sidebar", inSecondary(sidebar), sidebar)
	await sendInto(sidebar, `SIDEBAR-${RUN_ID}`)
	if (!(await waitForText(sidebar, `SIDEBAR-${RUN_ID}`, 30000))) {
		console.log("The sidebar chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(sidebar)

	// Work in an editor tab, so IT is the working surface — and then close that tab.
	const tab = await openChat("editor chat")
	await sendInto(tab, TAB_MARK)
	if (!(await waitForText(tab, TAB_MARK, 30000))) {
		console.log("The editor chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(tab)
	const activeBeforeClose = await activeSurface()
	assert(
		"2. the editor chat is the working surface before its tab closes",
		activeBeforeClose === tab,
		`active=${activeBeforeClose}`,
	)

	const closed = await closeEditorTabByX(TAB_MARK)
	assert("3. the working chat's tab could be closed", closed, closed ? "closed" : "the tab's close control was not reachable")
	if (!closed) {
		return report()
	}
	await sleep(3000)

	// ── The precondition this scenario exists for: no working surface is known. ─────────────
	const activeAfterClose = await activeSurface()
	assert(
		"4. with the working tab gone, no working surface is known",
		activeAfterClose === undefined,
		activeAfterClose === undefined ? "none" : `still ${activeAfterClose}`,
	)
	if (activeAfterClose !== undefined) {
		console.log("A working surface is still known, so the fallback path is not the one under test — aborting.")
		return report()
	}

	const surfacesBefore = await surfaceIds()

	// ── The command. ────────────────────────────────────────────────────────────────────────
	await runCommand("cline.settingsButtonClicked")
	await sleep(2500)

	const surfacesAfter = await surfaceIds()
	const spawned = surfacesAfter.filter((id) => !surfacesBefore.includes(id))
	assert(
		"5. the command spawned no new chat surface",
		spawned.length === 0,
		spawned.length === 0 ? "surface set unchanged" : `new surfaces: ${spawned.join(", ")}`,
	)
	const activeAfter = await activeSurface()
	assert(
		"6. the command revealed the configured location and made it the working surface",
		activeAfter === sidebar,
		`active=${activeAfter} sidebar=${sidebar}`,
	)
	const text = await surfaceText(sidebar)
	const showsSettings = text.includes("Settings") && text.includes("API Configuration")
	assert(
		"7. the revealed surface shows the Settings view — the command was delivered, not dropped",
		showsSettings,
		showsSettings ? "Settings view present" : `surface text starts: ${JSON.stringify(text.slice(0, 120))}`,
	)

	report()
}

run(main)
