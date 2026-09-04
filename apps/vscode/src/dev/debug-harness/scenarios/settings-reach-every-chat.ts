/**
 * Cline Cubed — a model change reaches EVERY live chat immediately.
 *
 * Two live chats, then the model id is changed through the real API-configuration handler
 * (the same one the settings UI reaches). Both chats' task proxies must carry the new model
 * shim at once — per the approved 2026-08-30 rule, a config event acts on every session,
 * never "whichever is focused", and immediately, not on some later turn. The old code wrote
 * the shim onto the focused singleton only, so every other running chat silently kept the
 * old configuration.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node --experimental-strip-types src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/settings-reach-every-chat.ts
 *
 * Exit code 0 = all assertions passed, 1 = an assertion failed, 2 = the scenario could not run.
 */

import { assert, freshApp, invokeRpc, liveTaskShims, openChat, report, run, sendInto, waitForQuiet, waitForText } from "./harness"

const RUN_ID = Date.now()
const A_MARK = `CFG-A-${RUN_ID}`
const B_MARK = `CFG-B-${RUN_ID}`
const NEW_MODEL = `cline-cubed-stub-switched-${RUN_ID}`

async function main(): Promise<void> {
	console.log(`\nCline Cubed — a model change reaches every live chat immediately\nrun: ${RUN_ID}\n`)
	await freshApp()

	const chatA = await openChat("first chat")
	await sendInto(chatA, A_MARK)
	if (!(await waitForText(chatA, A_MARK, 30000))) {
		console.log("The first chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(chatA)

	const chatB = await openChat("second chat")
	await sendInto(chatB, B_MARK)
	if (!(await waitForText(chatB, B_MARK, 30000))) {
		console.log("The second chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(chatB)

	const before = await liveTaskShims()
	assert(
		"1. both chats are live, each with its own model shim",
		before.length >= 2,
		`live task proxies: ${before.length} (${before.map((t) => `${t.id}=${t.model}`).join(", ")})`,
	)
	if (before.length < 2) {
		return report()
	}
	assert(
		"2. neither chat carries the new model yet",
		before.every((t) => t.model !== NEW_MODEL),
		"baseline models are the stub's own",
	)

	// ── Change the model through the real handler. ─────────────────────────────────────────
	await invokeRpc("cline.ModelsService", "updateApiConfigurationPartial", {
		apiConfiguration: {
			planModeOpenAiModelId: NEW_MODEL,
			actModeOpenAiModelId: NEW_MODEL,
		},
		updateMask: ["planModeOpenAiModelId", "actModeOpenAiModelId"],
	})

	// ── Immediately — no turn runs, no chat is reopened — every proxy carries it. ──────────
	const after = await liveTaskShims()
	const allSwitched = after.length >= 2 && after.every((t) => t.model === NEW_MODEL)
	assert(
		"3. EVERY live chat's proxy carries the new model shim, immediately",
		allSwitched,
		allSwitched
			? `all ${after.length} proxies now on ${NEW_MODEL}`
			: `still mixed: ${after.map((t) => `${t.id}=${t.model}`).join(", ")}`,
	)

	const beforeIds = new Set(before.map((t) => t.id))
	assert(
		"4. the change reconfigured the chats rather than ending or replacing any",
		after.length === before.length && after.every((t) => beforeIds.has(t.id)),
		`before=[${before.map((t) => t.id).join(", ")}] after=[${after.map((t) => t.id).join(", ")}]`,
	)

	report()
}

run(main)
