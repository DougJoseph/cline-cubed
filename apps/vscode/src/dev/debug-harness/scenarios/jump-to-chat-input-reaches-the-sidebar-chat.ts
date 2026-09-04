/**
 * Cline Cubed — "Jump to Chat Input" goes to the chat the person is WORKING IN.
 *
 * The command (`cline.focusChatInput`) is the same handler every code action funnels through, so
 * it must aim at the working chat by the same rule. The case that used to defeat it: working in a
 * SECONDARY SIDEBAR chat while an editor tab holds VS Code's own notion of "last focused." A
 * sidebar view fires no focus event the extension can hear, so unless sending into it counts, the
 * command falls back to the configured location — which, at Editor, opens a fresh Home tab
 * instead of reaching the chat in front of the person.
 *
 * Asserted directly: no new surface, no new tab, and the routing decision itself.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node --experimental-strip-types src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/jump-to-chat-input-reaches-the-sidebar-chat.ts
 *
 * Exit code 0 = all assertions passed, 1 = an assertion failed, 2 = the scenario could not run.
 */

import {
	assert,
	CHAT_LOCATION,
	extEval,
	freshApp,
	oneEditorTabStripText,
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
const inSecondary = (id: string) => id.startsWith("secondary-sidebar")

async function activeSurface(): Promise<string | undefined> {
	return extEval<string | undefined>("globalThis.__clineCubedDebug.activeChatSurface()")
}

async function main(): Promise<void> {
	console.log(`\nCline Cubed — Jump to Chat Input reaches the sidebar chat\nrun: ${RUN_ID}\n`)
	await freshApp({ newChatLocation: CHAT_LOCATION.secondarySidebar })

	const sidebar = await openChat("sidebar chat")
	assert("1. the first chat landed in the secondary sidebar", inSecondary(sidebar), sidebar)
	await sendInto(sidebar, `SIDEBAR-${RUN_ID}`)
	if (!(await waitForText(sidebar, `SIDEBAR-${RUN_ID}`, 30000))) {
		console.log("The sidebar chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(sidebar)

	// An editor tab, so VS Code's last-focused surface is NOT the sidebar.
	const tab = await openChat("editor chat")
	await sendInto(tab, `TAB-${RUN_ID}`)
	await waitForText(tab, `TAB-${RUN_ID}`, 30000)
	await waitForQuiet(tab)

	// Work in the sidebar again. Sending is what makes it the working chat.
	await sendInto(sidebar, `WORKING-${RUN_ID}`)
	await waitForText(sidebar, `WORKING-${RUN_ID}`, 30000)
	await waitForQuiet(sidebar)
	const activeBefore = await activeSurface()
	assert("2. the sidebar chat is the working chat before the command", activeBefore === sidebar, `active=${activeBefore}`)

	const surfacesBefore = await surfaceIds()
	const tabsBefore = await oneEditorTabStripText()

	await runCommand("cline.focusChatInput")
	await sleep(2000)

	const surfacesAfter = await surfaceIds()
	const spawned = surfacesAfter.filter((id) => !surfacesBefore.includes(id))
	assert(
		"3. the command spawned no new chat surface",
		spawned.length === 0,
		spawned.length === 0 ? "surface set unchanged" : `new surfaces: ${spawned.join(", ")}`,
	)
	const tabsAfter = await oneEditorTabStripText()
	assert(
		"4. the editor tab strip is unchanged (no Home tab opened)",
		tabsAfter === tabsBefore,
		`before="${tabsBefore}" after="${tabsAfter}"`,
	)
	const activeAfter = await activeSurface()
	assert("5. the command aimed at the sidebar chat", activeAfter === sidebar, `active=${activeAfter} sidebar=${sidebar}`)

	report()
}

run(main)
