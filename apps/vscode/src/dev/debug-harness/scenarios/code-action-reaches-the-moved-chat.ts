/**
 * Cline Cubed — a code action reaches the chat the person is WORKING IN, and no other.
 *
 * "Add to Cline Cubed" from the editor puts the selection into one chat's input. Which chat is a
 * real question once several are open, and the answer must be the one the person is working in
 * — not the one VS Code last reported as focused, and never all of them at once.
 *
 * The layout here is the one focus tracking cannot see: a chat in the SECONDARY SIDEBAR, worked
 * in by sending a message, while editor tabs opened later hold VS Code's own notion of "last
 * focused." A sidebar view fires no focus event the extension can hear, so the sidebar chat is
 * the working chat only because sending into it says so (and, when it is clicked into, because
 * the webview says so). Two more chats are open in editor tabs, one of them never sent into, so a
 * broadcast has somewhere to show up.
 *
 * What is asserted is read directly, never inferred from pixels: the routing decision itself
 * (`activeChatSurface()` on the debug handle), the set of open surfaces (no Home tab spawned),
 * and each chat's input box VALUE (the selection is in exactly one).
 *
 * Reads of an input focus it, and a focused webview now reports itself — so the routing decision
 * is asserted BEFORE any input is read.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node --experimental-strip-types src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/code-action-reaches-the-moved-chat.ts
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
const SNIPPET = `const codeActionProbe${RUN_ID} = 1`

const inSecondary = (id: string) => id.startsWith("secondary-sidebar")

/** The chat surface commands and code actions currently aim at — the routing decision itself. */
async function activeSurface(): Promise<string | undefined> {
	return extEval<string | undefined>("globalThis.__clineCubedDebug.activeChatSurface()")
}

/** A chat's input box VALUE, read without changing it. */
async function inputValueOf(surfaceId: string): Promise<string> {
	const res = await api("ui.react_input", { frame: frameOf(surfaceId), text: "", clear: false })
	return String((res as any)?.value ?? "")
}

async function main(): Promise<void> {
	console.log(`\nCline Cubed — a code action reaches the working chat and no other\nrun: ${RUN_ID}\n`)
	await freshApp({ newChatLocation: CHAT_LOCATION.secondarySidebar })

	// ── The sidebar chat, with a conversation. ──────────────────────────────────────────────
	const sidebar = await openChat("sidebar chat")
	assert("1. the first chat landed in the secondary sidebar", inSecondary(sidebar), sidebar)
	await sendInto(sidebar, `SIDEBAR-${RUN_ID}`)
	if (!(await waitForText(sidebar, `SIDEBAR-${RUN_ID}`, 30000))) {
		console.log("The sidebar chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(sidebar)

	// ── Two editor-tab chats. VS Code's last-focused surface is now a tab, not the sidebar. ─
	const tabA = await openChat("editor chat A")
	await sendInto(tabA, `TAB-A-${RUN_ID}`)
	await waitForText(tabA, `TAB-A-${RUN_ID}`, 30000)
	await waitForQuiet(tabA)
	const tabC = await openChat("editor chat C (never sent into)")
	assert("2. three distinct chats are open", new Set([sidebar, tabA, tabC]).size === 3, `${sidebar} ${tabA} ${tabC}`)

	// ── Work in the sidebar: send a message there. That, and only that, makes it the working
	//    chat — the sidebar was already visible, so no visibility event fires for it. ──────────
	await sendInto(sidebar, `WORKING-${RUN_ID}`)
	await waitForText(sidebar, `WORKING-${RUN_ID}`, 30000)
	await waitForQuiet(sidebar)

	const activeBefore = await activeSurface()
	assert(
		"3. after sending into the sidebar chat, it is the chat commands aim at",
		activeBefore === sidebar,
		`active=${activeBefore} sidebar=${sidebar}`,
	)

	// ── A text editor with a selection, then the code action. ───────────────────────────────
	const surfacesBefore = await surfaceIds()
	await runCommand("workbench.action.files.newUntitledFile")
	await sleep(800)
	await api("ui.type", { text: SNIPPET })
	await sleep(300)
	await runCommand("editor.action.selectAll")
	await sleep(300)
	await runCommand("cline.addToChat")
	await sleep(2000)

	// ── The routing decision, read before anything touches an input. ────────────────────────
	const activeAfter = await activeSurface()
	assert("4. the code action aimed at the sidebar chat", activeAfter === sidebar, `active=${activeAfter} sidebar=${sidebar}`)

	const surfacesAfter = await surfaceIds()
	const spawned = surfacesAfter.filter((id) => !surfacesBefore.includes(id))
	assert(
		"5. no new chat surface was spawned (no Home tab in place of the working chat)",
		spawned.length === 0,
		spawned.length === 0 ? "surface set unchanged" : `new surfaces: ${spawned.join(", ")}`,
	)

	// ── Where the selection actually went. Exactly one input holds it. ──────────────────────
	const inSidebar = await inputValueOf(sidebar)
	const inTabA = await inputValueOf(tabA)
	const inTabC = await inputValueOf(tabC)
	assert("6. the sidebar chat's input holds the selection", inSidebar.includes(SNIPPET), inSidebar.slice(0, 120) || "(empty)")
	assert("7. editor chat A's input does NOT hold it", !inTabA.includes(SNIPPET), inTabA.slice(0, 120) || "(empty)")
	assert(
		"8. editor chat C — never sent into — does NOT hold it either (no broadcast)",
		!inTabC.includes(SNIPPET),
		inTabC.slice(0, 120) || "(empty)",
	)

	report()
}

run(main)
