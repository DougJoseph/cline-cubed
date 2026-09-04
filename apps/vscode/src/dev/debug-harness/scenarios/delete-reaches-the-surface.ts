/**
 * Cline Cubed — deleting a chat reaches the surface showing it, and ONLY that chat.
 *
 * The defect this locks out (Doug, 2026-08-31): deleting a chat from the chats list left the
 * surface showing that chat untouched, rendering a deleted record — and typing there silently
 * forked a NEW chat behind the dead transcript. Worse, the old code compared the deleted id
 * against the SINGLETON and fired a bare clear on a match, which could end whichever session
 * was focused — a different chat entirely.
 *
 * What must hold now (the no-session-action-without-a-session-id plan, §3):
 *   - the deleted chat's surface honestly steps back to the home;
 *   - the deleted chat is gone from history;
 *   - typing on that surface starts a VISIBLY new chat, from a home;
 *   - a different chat that is MID-TURN keeps streaming, untouched.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node --experimental-strip-types src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/delete-reaches-the-surface.ts
 *
 * Exit code 0 = all assertions passed, 1 = an assertion failed, 2 = the scenario could not run.
 */

import {
	api,
	assert,
	chatsListText,
	clickDialogButton,
	freshApp,
	MARKERS,
	openChat,
	report,
	run,
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
const DOOM_MARK = `DOOM-${RUN_ID}`
const FRESH_MARK = `FRESH-${RUN_ID}`
/** The home's own words — what a surface shows once its chat is gone. */
const HOME_TEXT = "What can I do for you?"

async function main(): Promise<void> {
	console.log(`\nCline Cubed — deleting a chat reaches its surface, and only that chat\nrun: ${RUN_ID}\n`)
	await freshApp()

	// A chat that must be left completely alone — and left RUNNING mid-turn.
	const keep = await openChat("chat that keeps streaming")
	await sendInto(keep, KEEP_MARK)
	if (!(await waitForText(keep, KEEP_MARK, 30000))) {
		console.log("The first chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(keep)
	await sendInto(keep, `${KEEP_MARK}-turn ${MARKERS.slow}`)

	// The chat that will be deleted — its turn completes, so its row is in the chats list.
	const doomed = await openChat("chat to delete")
	await sendInto(doomed, DOOM_MARK)
	if (!(await waitForText(doomed, DOOM_MARK, 30000))) {
		console.log("The second chat never displayed its own message — aborting.")
		await stubRelease()
		return report()
	}
	await waitForQuiet(doomed)

	const held = await waitForHeldTurns(1)
	assert(
		"1. the other chat is genuinely mid-turn when the delete happens",
		held,
		held ? "the stub is holding its turn open" : `nothing held (${(await stubState()).held ?? 0})`,
	)

	const surfacesBefore = await surfaceIds()

	// ── Delete the chat from the chats list, like a user. ──────────────────────────────────
	// The chats list is usually already showing (a fresh launch opens it) — and ui.open_sidebar
	// TOGGLES the container, so calling it blindly here closed an open list and left every row
	// present-but-hidden. Open it only if the row is not already visible.
	const rowSelector = `.history-item:has-text("${DOOM_MARK}")`
	const rowVisible = async (timeout: number) => {
		try {
			await api("ui.wait_for_selector", { frame: "chats-list", selector: rowSelector, timeout })
			return true
		} catch {
			return false
		}
	}
	let clicked = false
	try {
		if (!(await rowVisible(6000))) {
			await api("ui.open_sidebar").catch(() => {})
			if (!(await rowVisible(10000))) {
				throw new Error("the chat's row never became visible in the chats list")
			}
		}
		await api("ui.click", {
			frame: "chats-list",
			selector: `.history-item:has-text("${DOOM_MARK}") [aria-label="Delete"]`,
			timeout: 8000,
		})
		clicked = true
	} catch (e: any) {
		assert("2. the chat's row offers its delete control", false, e?.message ?? String(e))
	}
	if (clicked) {
		assert("2. the chat's row offers its delete control", true, "delete icon clicked")
		const confirmed = await clickDialogButton("Delete")
		assert(
			"3. the confirmation dialog appears and can be confirmed",
			confirmed,
			confirmed ? "workbench dialog confirmed" : "no workbench dialog button found",
		)
		if (!confirmed) {
			await stubRelease()
			return report()
		}
	} else {
		await stubRelease()
		return report()
	}
	// The delete lands asynchronously after the dialog (eviction, an awaited session stop,
	// the history write, the state post) — poll for the outcome rather than racing a fixed
	// sleep against it.
	const settleDeadline = Date.now() + 20000
	let doomedAfter = await transcriptOf(doomed)
	let listText = await chatsListText()
	while (
		Date.now() < settleDeadline &&
		(doomedAfter.text.includes(DOOM_MARK) || !doomedAfter.text.includes(HOME_TEXT) || listText.includes(DOOM_MARK))
	) {
		await sleep(500)
		doomedAfter = await transcriptOf(doomed)
		listText = await chatsListText()
	}

	// ── The deleted chat's surface shows the home; the record is gone everywhere. ──────────
	const surfacesAfter = await surfaceIds()
	assert(
		"4. the deleted chat's surface is still open (deleting the chat does not close the tab)",
		surfacesAfter.includes(doomed),
		surfacesAfter.includes(doomed) ? `${doomed} still present` : `${doomed} is gone`,
	)
	assert(
		"5. no other surface disappeared",
		surfacesBefore.every((id) => surfacesAfter.includes(id)),
		`before=${surfacesBefore.join(",")} after=${surfacesAfter.join(",")}`,
	)

	assert(
		"6. the surface shows the home, not the deleted conversation",
		doomedAfter.text.includes(HOME_TEXT) && !doomedAfter.text.includes(DOOM_MARK),
		doomedAfter.text.includes(DOOM_MARK)
			? "the deleted conversation is still rendered — the delete never reached the surface"
			: doomedAfter.text.includes(HOME_TEXT)
				? "home shown, deleted record gone"
				: "neither home nor conversation — unexpected state",
	)

	assert(
		"7. the deleted chat is gone from the chats list",
		!listText.includes(DOOM_MARK),
		listText.includes(DOOM_MARK) ? "its row is still listed" : "no row for it",
	)

	// ── Typing on that surface starts a visibly NEW chat. ──────────────────────────────────
	await sendInto(doomed, FRESH_MARK)
	const freshShown = await waitForText(doomed, FRESH_MARK, 30000)
	const freshAfter = await transcriptOf(doomed)
	assert(
		"8. typing there starts a visibly new chat, with no trace of the deleted one",
		freshShown && !freshAfter.text.includes(DOOM_MARK),
		freshShown ? "new conversation, old record absent" : "the new message never appeared",
	)

	// ── The mid-turn chat was untouched throughout. ────────────────────────────────────────
	const stillHeld = await stubState()
	assert(
		"9. the OTHER chat's turn is still running after the delete",
		(stillHeld.held ?? 0) >= 1,
		(stillHeld.held ?? 0) >= 1 ? "still held, as it should be" : "its turn ended — the delete reached the wrong chat",
	)

	await stubRelease()
	await waitForQuiet(keep)
	const keepFinal = await transcriptOf(keep)
	assert(
		"10. the other chat still holds its own conversation",
		keepFinal.text.includes(KEEP_MARK) && !keepFinal.text.includes(HOME_TEXT),
		keepFinal.text.includes(KEEP_MARK) ? "own probe present" : "it lost its conversation",
	)

	report()
}

run(main)
