/**
 * Cline Cubed — reopening a chat that is already open reveals it; it never moves.
 *
 * The rule (Doug, 2026-08-29): accidentally reopening an open chat must never move it. Clicking
 * its history row somewhere else reveals the surface where it already lives and changes nothing —
 * no eviction, no blanked panel, no message forked into a new chat. Only a chat that is open
 * NOWHERE opens in the surface that was clicked.
 *
 * Both legs are asserted: (1) already open → revealed in place, the clicking surface untouched, a
 * follow-up still lands in the chat's own surface; (2) closed first, then clicked → opens in the
 * clicking surface.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/resume-identity.ts
 *
 * Exit code 0 = all assertions passed, 1 = an assertion failed, 2 = the scenario could not run.
 */

import {
	api,
	assert,
	assertHoldsOnly,
	freshApp,
	newChatFromChatsList,
	pressInChatClose,
	report,
	run,
	sendInto,
	sleep,
	transcriptOf,
	waitForQuiet,
	waitForText,
} from "./harness"

const RUN_ID = Date.now()
const ORIGINAL = `ORIGINAL-${RUN_ID}`
const BYSTANDER = `BYSTANDER-${RUN_ID}`
const FOLLOW_UP = `FOLLOWUP-${RUN_ID}`

/** Click the history row for a chat, in ONE named surface's recent/history list. Rows are
 *  labelled by the chat's first prompt — the run's own probe — so the row is found by the
 *  scenario's own text rather than by a selector that has to track the markup. */
async function openFromHistory(inSurface: string, text: string): Promise<boolean> {
	try {
		await api("ui.locator", { frame: `surface-id:${inSurface}`, text, action: "click" })
		return true
	} catch {
		return false
	}
}

async function main(): Promise<void> {
	console.log(`\nCline Cubed — a chat reopened from history is still itself\nrun: ${RUN_ID}\n`)
	await freshApp()

	// A bystander chat that must be untouched by any of this.
	const bystander = await newChatFromChatsList("bystander chat")
	await sendInto(bystander, BYSTANDER)
	if (!(await waitForText(bystander, BYSTANDER, 30000))) {
		console.log("The bystander chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(bystander)

	// The chat this scenario is about.
	const original = await newChatFromChatsList("original chat")
	await sendInto(original, ORIGINAL)
	if (!(await waitForText(original, ORIGINAL, 30000))) {
		console.log("The original chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(original)

	// A fresh chat, whose home lists the recent chats — the route a person takes back.
	const home = await newChatFromChatsList("home (for the history list)")
	await sleep(1500)
	const reopened = await openFromHistory(home, ORIGINAL)
	assert(
		"1. the earlier chat can be reopened from the history list",
		reopened,
		reopened ? "its row was clickable" : "the home offered no history row for it",
	)
	if (!reopened) {
		return report()
	}

	// The chat is ALREADY OPEN in its own surface, so the click must reveal it there and move
	// nothing. An earlier design moved the chat into the clicking surface — which blanked its old
	// panel mid-use, and a message typed into that blanked panel silently started a NEW chat.
	const reopenedSurface = original
	await sleep(2500)
	const stillThere = await waitForText(reopenedSurface, ORIGINAL, 30000)
	assert(
		"2. the chat still lives in its OWN surface — the click did not move it",
		stillThere,
		stillThere ? `still showing in ${reopenedSurface}` : "the chat's own surface no longer shows it",
	)
	if (!stillThere) {
		return report()
	}
	const homeUntouched = (await transcriptOf(home)).text.includes("What can I do for you?")
	assert(
		"2b. the clicking surface stayed on its home — nothing was adopted",
		homeUntouched,
		homeUntouched ? "home untouched" : "the clicking surface took the chat over",
	)

	// ── The follow-up: the step where a re-keyed chat sends its message elsewhere. ───────────
	await sendInto(reopenedSurface, FOLLOW_UP)
	const landed = await waitForText(reopenedSurface, FOLLOW_UP, 30000)
	assert(
		"3. a follow-up typed into the reopened chat lands in the reopened chat",
		landed,
		landed ? "found, as it should be" : "NOT found — the reopened chat lost its binding",
	)

	await waitForQuiet(reopenedSurface)
	await waitForQuiet(bystander)
	const reopenedFinal = await transcriptOf(reopenedSurface)
	const bystanderFinal = await transcriptOf(bystander)

	assert(
		"4. the reopened chat still holds its ORIGINAL conversation as well",
		reopenedFinal.text.includes(ORIGINAL),
		reopenedFinal.text.includes(ORIGINAL)
			? "original conversation intact"
			: // A failure must show what the surface DOES display, or diagnosis restarts from
				// guesswork every time.
				`the original conversation is gone; surface shows: ${JSON.stringify(reopenedFinal.text.slice(0, 400))}`,
	)
	assertHoldsOnly("5. the bystander chat", bystanderFinal, BYSTANDER, [
		{ probe: ORIGINAL, owner: "the reopened chat" },
		{ probe: FOLLOW_UP, owner: "the reopened chat" },
	])

	// ── Leg 2: a chat open NOWHERE opens in the surface that was clicked. ───────────────────
	const closed = await pressInChatClose(original)
	assert("6. the chat could be closed to free it", closed, closed ? "closed" : "the in-chat X was not reachable")
	if (closed) {
		await waitForText(original, "What can I do for you?", 30000)
		const reopenedHere = await openFromHistory(original, ORIGINAL)
		assert(
			"7. its history row is clickable from the freed surface's home",
			reopenedHere,
			reopenedHere ? "clicked" : "no row offered",
		)
		if (reopenedHere) {
			const openedInPlace = await waitForText(original, ORIGINAL, 30000)
			assert(
				"8. a chat open nowhere opens IN the clicked surface",
				openedInPlace,
				openedInPlace ? "opened where it was clicked" : "the clicked surface never showed it",
			)
		}
	}

	report()
}

run(main)
