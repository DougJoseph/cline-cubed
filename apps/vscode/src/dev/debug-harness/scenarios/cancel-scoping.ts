/**
 * Cline Cubed — Cancel stops the chat it was pressed in, and only that one.
 *
 * Two chats held genuinely mid-turn at the same time; Cancel pressed in one. The other must keep
 * running. A cancel that reaches for "the current task" instead of the chat it was pressed in
 * kills someone else's work, and the person watching sees a chat stop for no reason they caused.
 *
 * The stub holds each turn open until released, so both chats are really streaming when Cancel
 * lands — no sleep-and-hope, and no dependence on a model being slow.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/cancel-scoping.ts
 *
 * Exit code 0 = all assertions passed, 1 = an assertion failed, 2 = the scenario could not run.
 */

import {
	api,
	assert,
	assertHoldsOnly,
	frameOf,
	freshApp,
	MARKERS,
	openChat,
	report,
	run,
	sendInto,
	sleep,
	stubRelease,
	stubState,
	transcriptOf,
	waitForHeldTurns,
	waitForQuiet,
	waitForText,
} from "./harness"

const RUN_ID = Date.now()
const KEEP_MARK = `KEEP-${RUN_ID}`
const STOP_MARK = `STOP-${RUN_ID}`
const KEEP_PROBE = `${KEEP_MARK} ${MARKERS.slow}`
const STOP_PROBE = `${STOP_MARK} ${MARKERS.slow}`

/**
 * Press Cancel in one named chat — the control a person clicks while a turn is running.
 *
 * Asked for by ROLE and NAME rather than by a CSS selector. The control is a VS Code webview
 * toolkit button, which renders as a custom element with its own shadow root, so a
 * `button:has-text("Cancel")` selector never matches it. Role and name resolve through both.
 */
async function pressCancel(surfaceId: string): Promise<boolean> {
	const frame = frameOf(surfaceId)
	try {
		await api("ui.locator", { frame, role: "button", name: "Cancel", action: "click" })
		return true
	} catch {}
	for (const selector of ['vscode-button:has-text("Cancel")', '[aria-label="Cancel"]']) {
		try {
			await api("ui.click", { frame, selector })
			return true
		} catch {}
	}
	return false
}

async function main(): Promise<void> {
	console.log(`\nCline Cubed — Cancel is scoped to the chat it was pressed in\nrun: ${RUN_ID}\n`)
	await freshApp()

	// Both chats start a turn the stub will hold open.
	const keepChat = await openChat("chat that must keep running")
	await sendInto(keepChat, KEEP_PROBE)
	if (!(await waitForText(keepChat, KEEP_MARK, 30000))) {
		console.log("The first chat never displayed its own message — aborting.")
		return report()
	}

	const stopChat = await openChat("chat to cancel")
	await sendInto(stopChat, STOP_PROBE)
	if (!(await waitForText(stopChat, STOP_MARK, 30000))) {
		console.log("The second chat never displayed its own message — aborting.")
		return report()
	}

	// Both turns genuinely open before anything is cancelled — asked of the stub, not assumed.
	const bothHeld = await waitForHeldTurns(2)
	assert(
		"1. both chats are genuinely mid-turn at the same time",
		bothHeld,
		bothHeld ? "the stub is holding two turns open" : `only ${(await stubState()).held ?? 0} turn(s) held`,
	)
	if (!bothHeld) {
		await stubRelease()
		return report()
	}

	// ── Cancel, in ONE chat. ────────────────────────────────────────────────────────────────
	const pressed = await pressCancel(stopChat)
	assert("2. Cancel could be pressed in the second chat", pressed, pressed ? "clicked" : "Cancel button not reachable")
	if (!pressed) {
		await stubRelease()
		return report()
	}
	await sleep(3000)

	// Cancelling closes that turn's connection; the other chat's turn must still be held.
	const afterCancel = await stubState()
	assert(
		"3. the OTHER chat's turn is still running after the cancel",
		(afterCancel.held ?? 0) >= 1,
		(afterCancel.held ?? 0) >= 1
			? "still held, as it should be"
			: "no turn is held any more — the cancel stopped more than the chat it was pressed in",
	)

	// ── Both chats still hold their own conversations. ──────────────────────────────────────
	await stubRelease()
	await waitForQuiet(keepChat)
	await waitForQuiet(stopChat)
	const keepFinal = await transcriptOf(keepChat)
	const stopFinal = await transcriptOf(stopChat)
	assertHoldsOnly("4. the running chat", keepFinal, KEEP_MARK, [{ probe: STOP_MARK, owner: "the cancelled chat" }])
	assertHoldsOnly("6. the cancelled chat", stopFinal, STOP_MARK, [{ probe: KEEP_MARK, owner: "the running chat" }])

	report()
}

run(main)
