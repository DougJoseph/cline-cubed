/**
 * Cline Cubed — a new chat opens where the setting says, and never buries a live one.
 *
 * A sidebar holds ONE chat. So "where does the next chat go?" is not a single answer — it depends
 * on what the target sidebar is already holding, and getting it wrong either ignores the person's
 * setting or buries a chat they were using. The four states, from the V9 rulings:
 *
 *   (a) location = Secondary, sidebar never opened  → the chat lands IN the secondary sidebar
 *   (b) the sidebar then holds its empty home       → the next chat opens as an editor tab
 *   (c) the sidebar holds a LIVE chat               → the next chat opens as an editor tab,
 *                                                     and the live one is not disturbed
 *   (d) location = Editor                           → every press is a new editor tab
 *
 * Placement is read from the surface id, which names its container (`secondary-sidebar…` vs
 * `editor-panel…`) — the same identity the routing uses, so this asks the product where a chat
 * went rather than inferring it from pixels.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node --experimental-strip-types src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/chat-placement.ts
 *
 * Exit code 0 = all assertions passed, 1 = an assertion failed, 2 = the scenario could not run.
 */

import {
	assert,
	CHAT_LOCATION,
	freshApp,
	MARKERS,
	openChat,
	report,
	run,
	sendInto,
	stubRelease,
	stubState,
	transcriptOf,
	waitForHeldTurns,
	waitForQuiet,
	waitForText,
} from "./harness"

const RUN_ID = Date.now()
const LIVE_MARK = `LIVE-${RUN_ID}`

const inSecondary = (id: string) => id.startsWith("secondary-sidebar")
const inEditor = (id: string) => id.startsWith("editor-panel")
const where = (id: string) => (inSecondary(id) ? "the secondary sidebar" : inEditor(id) ? "an editor tab" : id)

async function main(): Promise<void> {
	console.log(`\nCline Cubed — a new chat opens where the setting says\nrun: ${RUN_ID}\n`)

	// ── (a) and (b): location = Secondary. ──────────────────────────────────────────────────
	await freshApp({ newChatLocation: CHAT_LOCATION.secondarySidebar })

	const first = await openChat("first chat (location = Secondary)")
	assert(
		"1. (a) with location = Secondary and the sidebar unopened, the chat lands in the SECONDARY SIDEBAR",
		inSecondary(first),
		`it opened in ${where(first)} (${first})`,
	)

	// The sidebar now holds a chat on its home. The next press must not displace it.
	const second = await openChat("second chat (sidebar now occupied)")
	assert(
		"2. (b) with the sidebar already holding a chat, the next chat opens as an EDITOR TAB",
		inEditor(second),
		`it opened in ${where(second)} (${second})`,
	)
	assert("3. (b) the two chats are different surfaces", first !== second, `first=${first} second=${second}`)

	// ── (c): the sidebar's chat is LIVE — a new chat must not bury it. ──────────────────────
	await sendInto(first, `${LIVE_MARK} ${MARKERS.slow}`)
	const held = await waitForHeldTurns(1)
	assert(
		"4. (c) the sidebar's chat is genuinely mid-turn",
		held,
		held ? "the stub is holding its turn open" : `nothing held (${(await stubState()).held ?? 0})`,
	)

	if (held) {
		const third = await openChat("third chat (sidebar holds a LIVE chat)")
		assert(
			"5. (c) with a LIVE chat in the sidebar, the next chat opens as an EDITOR TAB",
			inEditor(third),
			`it opened in ${where(third)} (${third})`,
		)
		const after = await stubState()
		assert(
			"6. (c) the sidebar's live chat is STILL running — it was not buried",
			(after.held ?? 0) >= 1,
			(after.held ?? 0) >= 1 ? "still held, as it should be" : "its turn ended when another chat opened",
		)
		await stubRelease()
		await waitForQuiet(first)
		const firstFinal = await transcriptOf(first)
		assert(
			"7. (c) the sidebar's chat still holds its own conversation",
			firstFinal.text.includes(LIVE_MARK),
			firstFinal.text.includes(LIVE_MARK) ? "own probe present" : "it lost its conversation",
		)
	} else {
		await stubRelease()
	}

	// ── (d): location = Editor — every press is a new tab. ──────────────────────────────────
	await freshApp({ newChatLocation: CHAT_LOCATION.editor })
	const tabA = await openChat("first chat (location = Editor)")
	assert("8. (d) with location = Editor, the first chat opens as an EDITOR TAB", inEditor(tabA), `${where(tabA)} (${tabA})`)

	// Give it a conversation so the next press has a real chat to open beside, not an empty home.
	await sendInto(tabA, `EDITOR-${RUN_ID}`)
	await waitForText(tabA, `EDITOR-${RUN_ID}`, 30000)
	await waitForQuiet(tabA)

	const tabB = await openChat("second chat (location = Editor)")
	assert("9. (d) the next chat is ANOTHER editor tab", inEditor(tabB), `${where(tabB)} (${tabB})`)
	assert("10. (d) it is a different surface, not the same tab reused", tabA !== tabB, `a=${tabA} b=${tabB}`)

	report()
}

run(main)
