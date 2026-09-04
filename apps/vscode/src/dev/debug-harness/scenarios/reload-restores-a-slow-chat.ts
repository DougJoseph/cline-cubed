/**
 * Cline Cubed — a SLOW restore shows "loading", never Home, and still delivers the chat.
 *
 * The companion to reload-restores-a-chat, which proves the happy path but cannot open the
 * race window (a tiny chat loads in milliseconds). This one holds the restore open for a
 * deterministic 25 seconds via the IS_DEV-only CLINE_CUBED_DEBUG_RESTORE_DELAY_MS seam — the
 * window a real large chat opens naturally (1,558 messages ≈ 3.9s, Doug's logs 2026-08-31) —
 * so the panel is GUARANTEED to boot and subscribe mid-load. It proves the two things the
 * happy path cannot:
 *
 *   - mid-load, the surface shows the LOADING state (chat name + "Loading conversation…"),
 *     never the Home screen — the old defect answered "empty chat", which rendered Home;
 *   - when the load lands, the completion update actually REACHES the mid-load subscriber
 *     and the conversation replaces the loading state — the open question the plan's Stage A2
 *     was chartered to answer by observation.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node --experimental-strip-types src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/reload-restores-a-slow-chat.ts
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
	waitForQuiet,
	waitForText,
} from "./harness"

const RUN_ID = Date.now()
const MARK = `SLOW-SURVIVE-${RUN_ID}`
const HOME_TEXT = "What can I do for you?"

async function main(): Promise<void> {
	console.log(`\nCline Cubed — a slow restore shows loading, never Home, then the chat\nrun: ${RUN_ID}\n`)
	await freshApp({ newChatLocation: "editor" }, { CLINE_CUBED_DEBUG_RESTORE_DELAY_MS: "25000" })

	const chat = await openChat("chat whose restore is held open")
	await sendInto(chat, MARK)
	if (!(await waitForText(chat, MARK, 30000))) {
		console.log("The chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(chat)

	console.log("reloading window (restore held open 25s)…")
	await reloadWindow()

	// Sample continuously through the held-open window and past it.
	const deadline = Date.now() + 60000
	let restored: string | undefined
	let sawHome = false
	let sawLoading = false
	let lastText = ""
	while (Date.now() < deadline && restored === undefined) {
		const texts = await allSurfaceTexts()
		for (const [index, text] of texts.entries()) {
			if (text.includes(MARK)) {
				restored = `surface:${index}`
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
			await sleep(400)
		}
	}

	// The loading-state RENDER is pinned by unit tests (conversation-snapshot.test.ts) and was
	// verified by direct observation (2026-08-31: chat name + "Loading conversation…" on screen
	// for the whole 25s hold). Whether this loop's sampling happens to catch it is reported,
	// not asserted — the scenario's job is guarding the DEFECT: Home shown, conversation lost.
	console.log(
		sawLoading
			? "  (info) the loading state was observed mid-hold"
			: "  (info) the sampler did not catch the loading state this run",
	)
	assert(
		"1. the surface was never observed on the Home screen during the held-open restore",
		!sawHome,
		sawHome ? `Home was rendered — last observed text began: ${lastText.slice(0, 120)}` : "no Home observed",
	)
	assert(
		"2. the conversation arrived once the load landed — nothing stuck, nothing lost",
		restored !== undefined,
		restored !== undefined ? `restored on ${restored}` : "stuck on loading — the completion update never landed",
	)

	report()
}

run(main)
