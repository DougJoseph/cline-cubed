/**
 * Cline Cubed — a window reload brings a chat back WITH its conversation.
 *
 * The gap this closes: no scenario ever reloaded the window, which is how the restore path
 * shipped with a defect that blanked any chat whose conversation loaded slowly — the panel
 * asked for its state mid-load, was answered with a FABRICATED empty conversation, and
 * rendered the Home screen under the chat's own title (Doug's 1,558-message chat, 2026-08-31,
 * on both 4.1.22 and 4.1.23). The fix gives "loading" its own state; this scenario proves the
 * integrated path: reload → the chat returns, its conversation returns, and the surface is
 * never observed on the Home screen while bound to the chat.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node --experimental-strip-types src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/reload-restores-a-chat.ts
 *
 * Exit code 0 = all assertions passed, 1 = an assertion failed, 2 = the scenario could not run.
 */

import {
	allSurfaceTexts,
	assert,
	freshApp,
	openChat,
	reloadWindow,
	report,
	run,
	sendInto,
	sleep,
	surfaceIds,
	waitForQuiet,
	waitForText,
} from "./harness"

const RUN_ID = Date.now()
const MARK = `SURVIVE-${RUN_ID}`
const HOME_TEXT = "What can I do for you?"

async function main(): Promise<void> {
	console.log(`\nCline Cubed — a window reload brings a chat back with its conversation\nrun: ${RUN_ID}\n`)
	// Doug's failing case was an editor tab — pin the location so the chat opens as one.
	await freshApp({ newChatLocation: "editor" })

	const chat = await openChat("chat that must survive the reload")
	await sendInto(chat, MARK)
	if (!(await waitForText(chat, MARK, 30000))) {
		console.log("The chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(chat)

	// ── Reload the window. ─────────────────────────────────────────────────────────────────
	console.log("reloading window…")
	await reloadWindow()

	// ── The surface comes back, and its conversation with it. ──────────────────────────────
	// Poll rather than sleep: the revive chain loads the conversation asynchronously. While
	// polling, record whether the surface was EVER observed rendering the Home screen — the
	// old defect's exact face. ("Loading conversation…" is allowed and expected; Home is not.)
	const deadline = Date.now() + 45000
	let restored: string | undefined
	let sawHome = false
	let sawLoading = false
	let lastText = ""
	while (Date.now() < deadline && restored === undefined) {
		const texts = await allSurfaceTexts()
		for (const [index, text] of texts.entries()) {
			if (text.includes(MARK)) {
				restored = `surface:${index}`
				lastText = text
				break
			}
			if (text.includes("Loading conversation")) {
				sawLoading = true
			}
			if (text.includes(HOME_TEXT)) {
				sawHome = true
				lastText = text
			}
		}
		if (restored === undefined) {
			await sleep(500)
		}
	}

	assert(
		"1. the chat's surface came back after the reload",
		(await surfaceIds().catch(() => [] as string[])).length > 0,
		"a chat surface is registered post-reload",
	)
	assert(
		"2. the conversation itself came back",
		restored !== undefined,
		restored !== undefined
			? `restored on ${restored}${sawLoading ? " (loading state was observed on the way)" : ""}`
			: `never appeared; last observed text began: ${lastText.slice(0, 120)}`,
	)
	assert(
		"3. the surface was never observed on the Home screen while its chat restored",
		!sawHome,
		sawHome ? "the Home screen was rendered — the old defect's exact face" : "no Home observed during restore",
	)

	report()
}

run(main)
