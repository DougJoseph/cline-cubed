/**
 * Cline Cubed — a failing turn marks the chat that failed, not the one being looked at.
 *
 * Two ways a turn can go wrong, both driven from the stub so neither depends on a provider
 * misbehaving at the right moment:
 *
 *   - the request fails outright (`STUB_ERROR`)
 *   - the model keeps producing output that cannot be used, until the run gives up (`STUB_BADTOOL`)
 *
 * Either way the error belongs to the chat whose turn it was. A failure that lands on whichever
 * chat happens to be focused tells someone their working chat broke when it did not, and says
 * nothing about the one that actually did.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/error-attribution.ts
 *
 * Exit code 0 = all assertions passed, 1 = an assertion failed, 2 = the scenario could not run.
 */

import {
	assert,
	assertHoldsOnly,
	freshApp,
	MARKERS,
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
const HEALTHY_MARK = `HEALTHY-${RUN_ID}`
const FAILING_MARK = `FAILING-${RUN_ID}`
const MISTAKE_MARK = `MISTAKE-${RUN_ID}`

/** Words a chat shows when its own turn has gone wrong. Matched case-insensitively and loosely on
 *  purpose: the assertion is about WHICH chat carries the failure, not about the exact wording,
 *  which is free to change without this scenario becoming wrong. */
const TROUBLE = ["error", "failed", "failure", "retry", "try again", "went wrong", "limit"]

/** Poll until a chat shows trouble, or give up. A failing turn is NOT immediate: the request is
 *  retried with backoff before anything is reported, so a fixed sleep either waits far too long
 *  or — as it did — checks before the row that proves the point has been rendered at all. */
async function waitForTrouble(surfaceId: string, timeoutMs = 90000): Promise<string | null> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const word = looksTroubled((await transcriptOf(surfaceId)).text)
		if (word) {
			return word
		}
		await sleep(2000)
	}
	return null
}

function looksTroubled(text: string): string | null {
	// Strip the markers first. `STUB_ERROR` contains the word "error", and the probe carrying it is
	// echoed into the very transcript being examined — so matching the raw text would find the
	// scenario's own instruction and report trouble that never happened.
	const haystack = Object.values(MARKERS)
		.reduce((acc, marker) => acc.split(marker).join(" "), text)
		.toLowerCase()
	return TROUBLE.find((word) => haystack.includes(word)) ?? null
}

async function main(): Promise<void> {
	console.log(`\nCline Cubed — a failing turn marks the chat that failed\nrun: ${RUN_ID}\n`)
	await freshApp()

	// A healthy chat, given its own conversation and then left alone.
	const healthy = await openChat("healthy chat")
	await sendInto(healthy, HEALTHY_MARK)
	if (!(await waitForText(healthy, HEALTHY_MARK, 30000))) {
		console.log("The healthy chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(healthy)
	const healthyBefore = await transcriptOf(healthy)
	const healthyTroubledBefore = looksTroubled(healthyBefore.text)

	// ── A turn that fails outright, in the OTHER chat. ──────────────────────────────────────
	const failing = await openChat("failing chat")
	await sendInto(failing, `${FAILING_MARK} ${MARKERS.error}`)
	await waitForText(failing, FAILING_MARK, 30000)
	const failingWord = await waitForTrouble(failing)
	await waitForQuiet(healthy)

	const failingAfter = await transcriptOf(failing)
	const healthyAfter = await transcriptOf(healthy)
	assert(
		"1. the failing chat shows the trouble",
		failingWord !== null,
		failingWord ? `it reports trouble ("${failingWord}")` : "no sign of the failure in the chat whose turn failed",
	)
	// Only meaningful if the healthy chat was clean beforehand — say so rather than assert a
	// comparison that was never valid.
	if (healthyTroubledBefore) {
		console.log(
			`  note  the healthy chat already read as troubled before the test ("${healthyTroubledBefore}") — skipping check 2`,
		)
	} else {
		const healthyWord = looksTroubled(healthyAfter.text)
		assert(
			"2. the healthy chat was NOT marked by the other chat's failure",
			healthyWord === null,
			healthyWord === null ? "clean, as it should be" : `it is showing trouble ("${healthyWord}") it did not cause`,
		)
	}
	assertHoldsOnly("3. the healthy chat", healthyAfter, HEALTHY_MARK, [{ probe: FAILING_MARK, owner: "the failing chat" }])

	// ── A run that keeps producing unusable output until it gives up, in a THIRD chat. ──────
	const mistaken = await openChat("mistake-limit chat")
	await sendInto(mistaken, `${MISTAKE_MARK} ${MARKERS.badTool}`)
	await waitForText(mistaken, MISTAKE_MARK, 30000)
	// This one takes several round trips by nature — the limit is reached by repetition.
	const mistakenWord = await waitForTrouble(mistaken)
	await waitForQuiet(healthy)

	const mistakenAfter = await transcriptOf(mistaken)
	const healthyFinal = await transcriptOf(healthy)
	assert(
		"5. the chat that ran into the limit is the one that reports it",
		mistakenWord !== null,
		mistakenWord ? `it reports trouble ("${mistakenWord}")` : "no sign of the limit in the chat that hit it",
	)
	if (!healthyTroubledBefore) {
		const healthyWord = looksTroubled(healthyFinal.text)
		assert(
			"6. the healthy chat is STILL unmarked",
			healthyWord === null,
			healthyWord === null ? "clean, as it should be" : `it is showing trouble ("${healthyWord}") from another chat's run`,
		)
	}
	assertHoldsOnly("7. the healthy chat, at the end", healthyFinal, HEALTHY_MARK, [
		{ probe: FAILING_MARK, owner: "the failing chat" },
		{ probe: MISTAKE_MARK, owner: "the mistake-limit chat" },
	])

	report()
}

run(main)
