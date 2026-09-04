/**
 * Cline Cubed — "Delete Everything" ends EVERY chat, each by its own id, honestly.
 *
 * Two live chats — one mid-turn — then delete all history. Every surface must land on its
 * home, every session must actually END (not survive invisibly), and the history must be
 * empty. The old shape bare-cleared the FOCUSED session before the user had even answered
 * the confirmation, and ended nothing else; under the no-session-action-without-a-session-id
 * plan, the handler acts only after confirmation and ends the deleted set by id.
 *
 * The RPC is driven through the real protobus handler (the same function the webview's
 * Delete-All button reaches), detached so the scenario can click the workbench confirmation
 * dialog the handler blocks on.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node --experimental-strip-types src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/delete-all-ends-all.ts
 *
 * Exit code 0 = all assertions passed, 1 = an assertion failed, 2 = the scenario could not run.
 */

import {
	assert,
	chatsListText,
	clickDialogButton,
	freshApp,
	invokeRpcDetached,
	liveTaskShims,
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
const A_MARK = `ALL-A-${RUN_ID}`
const B_MARK = `ALL-B-${RUN_ID}`
const HOME_TEXT = "What can I do for you?"

async function main(): Promise<void> {
	console.log(`\nCline Cubed — Delete Everything ends every chat, by id\nrun: ${RUN_ID}\n`)
	await freshApp()

	const chatA = await openChat("first chat")
	await sendInto(chatA, A_MARK)
	if (!(await waitForText(chatA, A_MARK, 30000))) {
		console.log("The first chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(chatA)

	const chatB = await openChat("second chat, mid-turn")
	await sendInto(chatB, B_MARK)
	if (!(await waitForText(chatB, B_MARK, 30000))) {
		console.log("The second chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(chatB)
	await sendInto(chatB, `${B_MARK}-turn ${MARKERS.slow}`)

	const held = await waitForHeldTurns(1)
	assert(
		"1. one chat is genuinely mid-turn when everything is deleted",
		held,
		held ? "the stub is holding its turn open" : `nothing held (${(await stubState()).held ?? 0})`,
	)

	const liveBefore = await liveTaskShims()
	assert(
		"2. both chats are live before the delete",
		liveBefore.length >= 2,
		`live task proxies: ${liveBefore.length} (${liveBefore.map((t) => t.id).join(", ")})`,
	)

	// ── Delete everything, through the real handler + the real confirmation dialog. ────────
	await invokeRpcDetached("cline.TaskService", "deleteAllTaskHistory", {})
	const confirmed = await clickDialogButton("Delete Everything")
	assert(
		"3. the confirmation dialog appears and Delete Everything can be chosen",
		confirmed,
		confirmed ? "workbench dialog confirmed" : "no workbench dialog button found",
	)
	if (!confirmed) {
		await stubRelease()
		return report()
	}
	await sleep(4000)

	// ── Every surface lands on its home. ───────────────────────────────────────────────────
	const aAfter = await transcriptOf(chatA)
	assert(
		"4. the first chat's surface shows the home, its conversation gone",
		aAfter.text.includes(HOME_TEXT) && !aAfter.text.includes(A_MARK),
		aAfter.text.includes(A_MARK) ? "still rendering its deleted conversation" : "home shown",
	)
	const bAfter = await transcriptOf(chatB)
	assert(
		"5. the mid-turn chat's surface shows the home too",
		bAfter.text.includes(HOME_TEXT) && !bAfter.text.includes(B_MARK),
		bAfter.text.includes(B_MARK) ? "still rendering its deleted conversation" : "home shown",
	)

	// ── Every session actually ended — nothing streams on invisibly. ───────────────────────
	const liveAfter = await liveTaskShims()
	assert(
		"6. no session survived the delete",
		liveAfter.length === 0,
		liveAfter.length === 0 ? "every session ended, by id" : `still live: ${liveAfter.map((t) => t.id).join(", ")}`,
	)

	// ── History is empty. ──────────────────────────────────────────────────────────────────
	const listText = await chatsListText()
	assert(
		"7. the chats list holds neither chat",
		!listText.includes(A_MARK) && !listText.includes(B_MARK),
		"no deleted rows remain",
	)

	await stubRelease()
	report()
}

run(main)
