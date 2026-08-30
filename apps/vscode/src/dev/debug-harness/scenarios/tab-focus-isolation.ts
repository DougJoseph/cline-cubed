/**
 * Cline Cubed — clicking one chat's tab does not disturb another chat.
 *
 * Switching editor tabs is the most ordinary thing a person does while two chats are working, and
 * it is a place a single-active-session design goes wrong quietly: bringing one chat to the front
 * must not stop, blank or re-target the chat that was already running behind it.
 *
 * The chat left running is held genuinely mid-turn by the stub, so "still running" is a fact asked
 * of the stub rather than inferred from the screen.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node --experimental-strip-types src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/tab-focus-isolation.ts
 *
 * Exit code 0 = all assertions passed, 1 = an assertion failed, 2 = the scenario could not run.
 */

import {
	assert,
	assertHoldsOnly,
	clickEditorTab,
	freshApp,
	MARKERS,
	oneEditorTabStripText,
	openChat,
	report,
	run,
	sendInto,
	sleep,
	stubRelease,
	stubState,
	transcriptOf,
	typeInto,
	waitForHeldTurns,
	waitForQuiet,
	waitForText,
} from "./harness"

const RUN_ID = Date.now()
const BUSY_MARK = `BUSY-${RUN_ID}`
const IDLE_MARK = `IDLE-${RUN_ID}`

async function main(): Promise<void> {
	console.log(`\nCline Cubed — clicking a tab leaves the other chat alone\nrun: ${RUN_ID}\n`)
	await freshApp()

	// The chat that must keep working: given a conversation, then a turn the stub holds open.
	const busy = await openChat("busy chat")
	await sendInto(busy, BUSY_MARK)
	if (!(await waitForText(busy, BUSY_MARK, 30000))) {
		console.log("The first chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(busy)
	await sendInto(busy, `${BUSY_MARK}-turn ${MARKERS.slow}`)

	// A second chat, which will be the one brought to the front.
	const idle = await openChat("second chat")
	await sendInto(idle, IDLE_MARK)
	if (!(await waitForText(idle, IDLE_MARK, 30000))) {
		console.log("The second chat never displayed its own message — aborting.")
		await stubRelease()
		return report()
	}

	const held = await waitForHeldTurns(1)
	assert(
		"1. the first chat is genuinely mid-turn before any tab is clicked",
		held,
		held ? "the stub is holding its turn open" : `nothing held (${(await stubState()).held ?? 0})`,
	)
	if (!held) {
		await stubRelease()
		return report()
	}

	// ── Click the OTHER chat's tab, bringing it to the front. ───────────────────────────────
	console.log(`one editor group\u0027s tab strip: ${JSON.stringify(await oneEditorTabStripText())}`)
	const clicked = await clickEditorTab(IDLE_MARK)
	assert("2. the second chat's editor tab could be clicked", clicked, clicked ? "clicked" : "tab not reachable")
	if (!clicked) {
		await stubRelease()
		return report()
	}
	await sleep(3000)

	// ── The chat behind it must still be running. ───────────────────────────────────────────
	const after = await stubState()
	assert(
		"3. the first chat's turn is STILL running after the other tab was brought to the front",
		(after.held ?? 0) >= 1,
		(after.held ?? 0) >= 1
			? "still held, as it should be"
			: "its turn ended — bringing another chat forward stopped the chat that was working",
	)

	// ── Both chats still own their own conversations, and both still accept input. ──────────
	await stubRelease()
	await waitForQuiet(busy)
	await waitForQuiet(idle)
	const busyFinal = await transcriptOf(busy)
	const idleFinal = await transcriptOf(idle)
	assertHoldsOnly("4. the chat that was working", busyFinal, BUSY_MARK, [{ probe: IDLE_MARK, owner: "the second chat" }])
	assertHoldsOnly("6. the chat brought forward", idleFinal, IDLE_MARK, [{ probe: BUSY_MARK, owner: "the first chat" }])

	let usable = false
	try {
		usable = (await typeInto(busy, `${BUSY_MARK}-typing`)).includes(BUSY_MARK)
		await typeInto(busy, "").catch(() => "")
	} catch {
		usable = false
	}
	assert(
		"8. the chat that was working still accepts input after losing focus",
		usable,
		usable ? "input accepted" : "it stopped accepting input once another tab was brought forward",
	)

	report()
}

run(main)
