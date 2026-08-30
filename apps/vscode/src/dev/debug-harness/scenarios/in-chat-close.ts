/**
 * Cline Cubed — the in-chat "X" closes ONE chat, and closes it in place.
 *
 * The X returns a chat to the "What can I do for you?" home. Two things must hold, and each has
 * been wrong before:
 *
 *   - it must NOT close the editor tab — the surface stays, ready for the next chat;
 *   - it must affect ONLY the chat it was pressed in, leaving every other chat untouched, even
 *     one that is mid-turn.
 *
 * The chat left alone is held genuinely mid-turn by the stub, so "untouched" is a fact asked of
 * the stub rather than read off the screen.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node --experimental-strip-types src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/in-chat-close.ts
 *
 * Exit code 0 = all assertions passed, 1 = an assertion failed, 2 = the scenario could not run.
 */

import {
	assert,
	freshApp,
	MARKERS,
	openChat,
	pressInChatClose,
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
const CLOSE_MARK = `CLOSE-${RUN_ID}`
/** The home's own words — what a chat shows once its conversation has been closed out. */
const HOME_TEXT = "What can I do for you?"

async function main(): Promise<void> {
	console.log(`\nCline Cubed — the in-chat X closes one chat, in place\nrun: ${RUN_ID}\n`)
	await freshApp()

	// A chat that must be left completely alone — and left RUNNING.
	const keep = await openChat("chat that must be left alone")
	await sendInto(keep, KEEP_MARK)
	if (!(await waitForText(keep, KEEP_MARK, 30000))) {
		console.log("The first chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(keep)
	await sendInto(keep, `${KEEP_MARK}-turn ${MARKERS.slow}`)

	// The chat whose X will be pressed.
	const closing = await openChat("chat to close")
	await sendInto(closing, CLOSE_MARK)
	if (!(await waitForText(closing, CLOSE_MARK, 30000))) {
		console.log("The second chat never displayed its own message — aborting.")
		await stubRelease()
		return report()
	}
	await waitForQuiet(closing)

	const held = await waitForHeldTurns(1)
	assert(
		"1. the other chat is genuinely mid-turn when the X is pressed",
		held,
		held ? "the stub is holding its turn open" : `nothing held (${(await stubState()).held ?? 0})`,
	)

	const surfacesBefore = await surfaceIds()

	// ── Press the X. ────────────────────────────────────────────────────────────────────────
	const pressed = await pressInChatClose(closing)
	assert("2. the in-chat X could be pressed", pressed, pressed ? "pressed" : "the X was not reachable")
	if (!pressed) {
		await stubRelease()
		return report()
	}
	await sleep(3000)

	// ── That chat returns to the home, and its surface SURVIVES. ────────────────────────────
	const surfacesAfter = await surfaceIds()
	assert(
		"3. the closed chat's surface is still open (the X does not close the tab)",
		surfacesAfter.includes(closing),
		surfacesAfter.includes(closing)
			? `${closing} still present`
			: `${closing} is gone — the X closed the surface instead of clearing it`,
	)
	assert(
		"4. no other surface disappeared",
		surfacesBefore.every((id) => surfacesAfter.includes(id)),
		`before=${surfacesBefore.join(",")} after=${surfacesAfter.join(",")}`,
	)

	const closedAfter = await transcriptOf(closing)
	assert(
		"5. the closed chat shows the home",
		closedAfter.text.includes(HOME_TEXT),
		closedAfter.text.includes(HOME_TEXT) ? "showing the home" : "it is not showing the home",
	)
	// The home lists RECENT chats by title, so the closed chat's own probe legitimately reappears
	// there. What must NOT be present is the conversation still running as this chat's own.
	assert(
		"6. the closed chat is no longer running its old conversation",
		!closedAfter.text.includes(`${CLOSE_MARK}-`),
		"its own turn is not still in progress here",
	)

	// ── The other chat is untouched, and still running. ─────────────────────────────────────
	const stillHeld = await stubState()
	assert(
		"7. the OTHER chat's turn is still running after the X",
		(stillHeld.held ?? 0) >= 1,
		(stillHeld.held ?? 0) >= 1 ? "still held, as it should be" : "its turn ended — the X reached the wrong chat",
	)

	await stubRelease()
	await waitForQuiet(keep)
	const keepFinal = await transcriptOf(keep)
	assert(
		"8. the other chat still holds its own conversation",
		keepFinal.text.includes(KEEP_MARK),
		keepFinal.text.includes(KEEP_MARK) ? "own probe present" : "it lost its conversation",
	)
	assert(
		"9. the other chat was NOT returned to the home",
		!keepFinal.text.includes(HOME_TEXT),
		keepFinal.text.includes(HOME_TEXT) ? "it was cleared too — the X was not scoped" : "still its own chat",
	)

	report()
}

run(main)
