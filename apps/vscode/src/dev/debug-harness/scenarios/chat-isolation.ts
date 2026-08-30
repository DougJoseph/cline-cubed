/**
 * Cline Cubed — chat isolation across a rename.
 *
 * Drives the sequence a person actually performs: a chat running in one editor tab, a second chat
 * started in another tab, that second chat RENAMED from its own header, then a message typed into
 * it. Asserts the message is displayed and executed in its own chat and nowhere else, both before
 * and after the rename — renaming must not disturb which conversation a chat owns.
 *
 * A rename is worth its own scenario because a chat's DISPLAYED name is what several other things
 * key off (the editor tab, history rows, the recent list); the routing must key off the chat's
 * identity instead, and stay put when the name moves.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/chat-isolation.ts
 *
 * Exit code 0 = all assertions passed, 1 = an assertion failed, 2 = the scenario could not run.
 */

import {
	api,
	assert,
	assertHoldsOnly,
	frameOf,
	freshApp,
	openChat,
	report,
	run,
	sendInto,
	sleep,
	transcriptOf,
	waitForQuiet,
	waitForText,
} from "./harness"

const RUN_ID = Date.now()
/** Markers that cannot collide with anything else on screen, nor with each other. */
const PROBE_OLD = `PROBE-OLD-${RUN_ID}`
const PROBE_NEW_FIRST = `PROBE-NEW-FIRST-${RUN_ID}`
const PROBE_NEW_AFTER_RENAME = `PROBE-NEW-AFTER-RENAME-${RUN_ID}`
const RENAME_TO = `Renamed Chat ${RUN_ID}`

async function main(): Promise<void> {
	console.log(`\nCline Cubed — chat isolation across a rename\nrun: ${RUN_ID}\n`)
	await freshApp()

	// ── The OLD chat: an editor tab with its own conversation. ──────────────────────────────
	const oldChat = await openChat("old chat")
	await sendInto(oldChat, PROBE_OLD)
	if (!(await waitForText(oldChat, PROBE_OLD))) {
		console.log("The first chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(oldChat)

	// ── The BRAND-NEW chat: a second editor tab, first prompt typed. ────────────────────────
	const newChat = await openChat("new chat")
	assert("two chat surfaces are open (old tab + new tab)", oldChat !== newChat, `old=${oldChat}, new=${newChat}`)

	await sendInto(newChat, PROBE_NEW_FIRST)
	const firstArrived = await waitForText(newChat, PROBE_NEW_FIRST)
	assert(
		"1. the new chat's first prompt appears in the new chat",
		firstArrived,
		firstArrived ? "found, as it should be" : "NOT found in the chat it was typed into",
	)
	await waitForQuiet(newChat)

	const oldBefore = await transcriptOf(oldChat)
	assert(
		"2. the new chat's first prompt did NOT land in the old chat",
		!oldBefore.text.includes(PROBE_NEW_FIRST),
		oldBefore.text.includes(PROBE_NEW_FIRST) ? "the old chat is showing the new chat's prompt" : "absent, as it should be",
	)

	// ── RENAME the new chat from its own header. ────────────────────────────────────────────
	let renamed = false
	try {
		const frame = frameOf(newChat)
		await api("ui.click", { frame, selector: '[aria-label^="Rename chat"]' })
		await sleep(500)
		await api("ui.fill", { frame, selector: "input", text: RENAME_TO })
		await api("ui.press", { frame, selector: "input", key: "Enter" })
		await sleep(1500)
		renamed = true
	} catch (e) {
		console.log(`rename step failed (${(e as Error).message}) — continuing; isolation must hold regardless`)
	}
	assert(
		"3. the new chat could be renamed from its header",
		renamed,
		renamed ? `renamed to "${RENAME_TO}"` : "rename UI not reachable",
	)

	// ── The step the whole scenario exists for: type into the renamed chat. ─────────────────
	await sendInto(newChat, PROBE_NEW_AFTER_RENAME)
	const afterArrived = await waitForText(newChat, PROBE_NEW_AFTER_RENAME)
	assert(
		"4. the post-rename message appears in the chat it was typed into",
		afterArrived,
		afterArrived ? "found in the new chat" : "NOT found in the new chat",
	)

	await waitForQuiet(newChat)
	await waitForQuiet(oldChat)
	const newAfter = await transcriptOf(newChat)
	const oldAfter = await transcriptOf(oldChat)

	// 5–8: each chat holds its own conversation and none of the other's, in both directions.
	assertHoldsOnly("5. the old chat", oldAfter, PROBE_OLD, [
		{ probe: PROBE_NEW_FIRST, owner: "the new chat" },
		{ probe: PROBE_NEW_AFTER_RENAME, owner: "the renamed chat" },
	])
	assertHoldsOnly("8. the renamed chat", newAfter, PROBE_NEW_AFTER_RENAME, [{ probe: PROBE_OLD, owner: "the old chat" }])

	// Secondary signal only — printed, never decisive (see harness.assertHoldsOnly).
	if (oldBefore.hash !== oldAfter.hash) {
		console.log(
			`  note  the old chat's transcript moved on its own while the new chat was used: ` +
				`${oldBefore.length} → ${oldAfter.length} chars. Not a failure by itself — the content ` +
				`checks above are what decide isolation.`,
		)
	}

	report()
}

run(main)
