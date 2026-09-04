/**
 * Cline Cubed — a command aimed at a TAPPED Home tab reaches that tab.
 *
 * A chat closed to the home in an editor tab leaves a tab a person can keep working in — the next
 * chat is composed there. A tap into it makes it the working surface, and Jump to Chat Input (and
 * every code action, which takes the same path) must then land there, not in whichever chat the
 * configured location happens to hold. The reveal step finds the tapped tab among every open
 * panel, including one that has gone back to the home after its chat closed.
 *
 * Judged two ways: the working surface the extension host reports, and the surface set plus the
 * editor tab strip, which must not change — nothing spawned, nothing revealed elsewhere.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node --experimental-strip-types src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/home-tab-reaches-the-tapped-tab.ts
 *
 * Exit code 0 = all assertions passed, 1 = an assertion failed, 2 = the scenario could not run.
 */

import {
	api,
	assert,
	CHAT_LOCATION,
	extEval,
	frameOf,
	freshApp,
	oneEditorTabStripText,
	openChat,
	pressInChatClose,
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
const inSecondary = (id: string) => id.startsWith("secondary-sidebar")

async function activeSurface(): Promise<string | undefined> {
	return extEval<string | undefined>("globalThis.__clineCubedDebug.activeChatSurface()")
}

/** A tap into a surface's prompt box — focusing the input is what a person does to start typing. */
async function tapInto(surfaceId: string): Promise<void> {
	await api("ui.react_input", { frame: frameOf(surfaceId), text: "", clear: false })
}

async function main(): Promise<void> {
	console.log(`\nCline Cubed — a command reaches the tapped Home tab\nrun: ${RUN_ID}\n`)
	// The configured location is the SIDEBAR on purpose: it is where the fallback would go if the
	// tapped tab were not found, which is exactly the outcome this scenario must rule out.
	await freshApp({ newChatLocation: CHAT_LOCATION.secondarySidebar })

	const sidebar = await openChat("sidebar chat")
	assert("1. the first chat landed in the secondary sidebar", inSecondary(sidebar), sidebar)
	await sendInto(sidebar, `SIDEBAR-${RUN_ID}`)
	if (!(await waitForText(sidebar, `SIDEBAR-${RUN_ID}`, 30000))) {
		console.log("The sidebar chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(sidebar)

	// An editor tab with a conversation, then closed to the home with the in-chat X. The tab
	// survives; its chat does not show there any more.
	const tab = await openChat("editor chat")
	await sendInto(tab, `TAB-${RUN_ID}`)
	if (!(await waitForText(tab, `TAB-${RUN_ID}`, 30000))) {
		console.log("The editor chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(tab)
	const pressed = await pressInChatClose(tab)
	assert("2. the editor chat could be closed to the home", pressed, pressed ? "pressed" : "the X was not reachable")
	if (!pressed) {
		return report()
	}
	await sleep(3000)
	assert("3. the tab is still open after closing its chat to the home", (await surfaceIds()).includes(tab), tab)

	// Make the sidebar the working chat first, so the tap below is what changes it.
	await sendInto(sidebar, `WORKING-${RUN_ID}`)
	await waitForText(sidebar, `WORKING-${RUN_ID}`, 30000)
	await waitForQuiet(sidebar)

	// ── The tap. ────────────────────────────────────────────────────────────────────────────
	await tapInto(tab)
	await sleep(1000)
	const activeAfterTap = await activeSurface()
	assert(
		"4. tapping into the Home tab made it the working surface",
		activeAfterTap === tab,
		`active=${activeAfterTap} tab=${tab}`,
	)
	if (activeAfterTap !== tab) {
		console.log("The tap did not register, so the command's target is not the one under test — aborting.")
		return report()
	}

	const surfacesBefore = await surfaceIds()
	const tabsBefore = await oneEditorTabStripText()

	// ── The command. ────────────────────────────────────────────────────────────────────────
	await runCommand("cline.focusChatInput")
	await sleep(2000)

	const surfacesAfter = await surfaceIds()
	const spawned = surfacesAfter.filter((id) => !surfacesBefore.includes(id))
	assert(
		"5. the command spawned no new chat surface",
		spawned.length === 0,
		spawned.length === 0 ? "surface set unchanged" : `new surfaces: ${spawned.join(", ")}`,
	)
	const tabsAfter = await oneEditorTabStripText()
	assert("6. the editor tab strip is unchanged", tabsAfter === tabsBefore, `before="${tabsBefore}" after="${tabsAfter}"`)
	const activeAfter = await activeSurface()
	assert(
		"7. the command aimed at the tapped Home tab — not the sidebar chat",
		activeAfter === tab,
		activeAfter === tab ? `active=${activeAfter}` : `active=${activeAfter} (tab=${tab}, sidebar=${sidebar})`,
	)

	report()
}

run(main)
