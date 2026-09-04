/**
 * Cline Cubed — closing a chat's TAB ends that chat, and a group's Close All ends every chat it
 * closed.
 *
 * Doug's standing ruling: the in-chat X, the sidebar X, and closing a chat's tab all END the chat.
 * The tab half of that ruling was not being kept. `panel.onDidDispose` — the only thing the panel
 * path listened to — does not fire when a tab is closed by its own X or by a group's Close All, so
 * the chat kept running invisibly while its surface was gone, holding a registry claim nobody
 * could see or reach. The fix ends those chats from the tabs API's own closed-tab report
 * (`registerChatTabCloseReconciler`, chatEditorPanel.ts).
 *
 * This scenario is the test that fix did not have. Every assertion about "the chat ended" is asked
 * of the extension host's live task list — a fact about what is running, never a reading of the
 * screen, because the whole defect was a chat that ran while showing nothing.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node --experimental-strip-types src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/tab-close-ends-the-chat.ts
 *
 * Exit code 0 = all assertions passed, 1 = an assertion failed, 2 = the scenario could not run.
 */

import {
	assert,
	CHAT_LOCATION,
	closeEditorTabByX,
	freshApp,
	liveTaskShims,
	MARKERS,
	oneEditorTabStripText,
	openChat,
	report,
	run,
	runCommand,
	sendInto,
	sleep,
	stubRelease,
	stubState,
	surfaceIds,
	transcriptOf,
	waitForHeldTurns,
	waitForQuiet,
	waitForText,
} from "./harness"

const RUN_ID = Date.now()
const KEEP_MARK = `KEEP-${RUN_ID}`
const CLOSE_MARK = `CLOSE-${RUN_ID}`

async function main(): Promise<void> {
	console.log(`\nCline Cubed — closing a chat's tab ends that chat\nrun: ${RUN_ID}\n`)
	// Both gestures under test — a tab's X and the group's Close All — are EDITOR gestures, so
	// both chats must open as editor tabs. Stated, not assumed: a chat that lands in the sidebar
	// is untouched by Close All (correctly), and the scenario would then fail for a reason that
	// has nothing to do with what it tests.
	await freshApp({ newChatLocation: CHAT_LOCATION.editor })

	// The chat that must survive the other's tab closing — and must survive it STILL RUNNING, so
	// "untouched" is a fact asked of the stub rather than read off the screen.
	const keep = await openChat("chat that must survive")
	await sendInto(keep, KEEP_MARK)
	if (!(await waitForText(keep, KEEP_MARK, 30000))) {
		console.log("The surviving chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(keep)

	// The chat whose tab gets closed.
	const closing = await openChat("chat whose tab is closed")
	await sendInto(closing, CLOSE_MARK)
	if (!(await waitForText(closing, CLOSE_MARK, 30000))) {
		console.log("The chat to be closed never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(closing)

	// Put the survivor mid-turn, held open by the stub.
	await sendInto(keep, `${KEEP_MARK}-turn ${MARKERS.slow}`)
	const held = await waitForHeldTurns(1)
	assert(
		"1. the surviving chat is genuinely mid-turn when the other tab is closed",
		held,
		held ? "the stub is holding its turn open" : `nothing held (${(await stubState()).held ?? 0})`,
	)
	if (!held) {
		await stubRelease()
		return report()
	}

	const liveBefore = await liveTaskShims()
	assert(
		"2. both chats are live before anything is closed",
		liveBefore.length >= 2,
		`live sessions: ${liveBefore.length} (${liveBefore.map((t) => t.id).join(", ")})`,
	)
	if (liveBefore.length < 2) {
		await stubRelease()
		return report()
	}

	// ── Close ONE chat's tab, by its own X. ─────────────────────────────────────────────────
	console.log(`one editor group's tab strip: ${JSON.stringify(await oneEditorTabStripText())}`)
	const closed = await closeEditorTabByX(CLOSE_MARK)
	assert("3. the chat's tab X could be clicked", closed, closed ? "clicked" : "the tab's close control was not reachable")
	if (!closed) {
		await stubRelease()
		return report()
	}
	await sleep(4000)

	// ── That surface is gone… ───────────────────────────────────────────────────────────────
	const surfacesAfter = await surfaceIds()
	assert(
		"4. the closed chat's surface is gone",
		!surfacesAfter.includes(closing),
		!surfacesAfter.includes(closing) ? `${closing} closed` : `${closing} is still open — the tab did not close`,
	)

	// ── …and, THE DEFECT, its session actually ENDED rather than running on invisibly. ──────
	const liveAfterX = await liveTaskShims()
	assert(
		"5. closing the tab ENDED that chat — it is not still running invisibly",
		liveAfterX.length === liveBefore.length - 1,
		liveAfterX.length === liveBefore.length - 1
			? `live sessions ${liveBefore.length} → ${liveAfterX.length}`
			: `live sessions ${liveBefore.length} → ${liveAfterX.length} — the closed chat survived its own tab`,
	)

	// ── The other chat is untouched, and still running. ─────────────────────────────────────
	const stillHeld = await stubState()
	assert(
		"6. the OTHER chat's turn is still running",
		(stillHeld.held ?? 0) >= 1,
		(stillHeld.held ?? 0) >= 1 ? "still held, as it should be" : "its turn ended — the close reached the wrong chat",
	)
	assert(
		"7. the other chat's surface is still open",
		surfacesAfter.includes(keep),
		surfacesAfter.includes(keep) ? `${keep} still present` : `${keep} disappeared with the other chat's tab`,
	)
	const keepMidway = await transcriptOf(keep)
	assert(
		"8. the other chat still holds its own conversation",
		keepMidway.text.includes(KEEP_MARK),
		keepMidway.text.includes(KEEP_MARK) ? "own probe present" : "it lost its conversation",
	)

	// ── Now the group's Close All — the second gesture the ruling names. ────────────────────
	// `workbench.action.closeAllEditors` is the exact command the group's "…" → Close All menu
	// item invokes; it is driven by id for the reason the harness's runCommand explains.
	await runCommand("workbench.action.closeAllEditors")
	await sleep(4000)

	const surfacesFinal = await surfaceIds()
	assert(
		"9. Close All closed every chat surface",
		surfacesFinal.length === 0,
		surfacesFinal.length === 0 ? "no chat surfaces remain" : `still open: ${surfacesFinal.join(", ")}`,
	)

	const liveFinal = await liveTaskShims()
	assert(
		"10. Close All ENDED every chat it closed — including the one mid-turn",
		liveFinal.length === 0,
		liveFinal.length === 0
			? "every session ended with its tab"
			: `still live: ${liveFinal.map((t) => t.id).join(", ")} — a closed chat is still running`,
	)

	// Reported, not asserted: whether the stub's held turn drops when its chat ends is the stub's
	// own bookkeeping, not the product behaviour under test.
	console.log(`stub held turns after Close All: ${(await stubState()).held ?? 0}`)

	await stubRelease()
	report()
}

run(main)
